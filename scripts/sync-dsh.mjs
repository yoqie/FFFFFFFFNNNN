#!/usr/bin/env node
/**
 * sync-dsh.mjs —— 同步 DSH（DeepSeek Harness 飞牛版）应用到 FnDepot 索引
 *
 * 上游数据源（GitHub Releases，按顺序合并，靠后者优先）：
 *   cliii-one/DSH_FNOS —— 原始仓库（历史版本为单架构 _all.fpk）
 *   yoqie/DSH_FNOS     —— fork，双架构构建（_amd64.fpk / _arm64.fpk）
 *
 * 产出：
 *   apps/dsh.json        应用详情（releases[].packages: arm/x86 下载地址 + sha256 + size）
 *   build/dsh/meta.json  应用元数据（供 update-index.mjs 重建 fnpack.json / README.md）
 *
 * 注意：本脚本会把 download_url 重置为上游 Release 地址；工作流随后运行
 * scripts/mirror-dsh.mjs 把最新版 fpk 镜像到本源 Release 并改回本源地址。
 *
 * 用法：node scripts/sync-dsh.mjs [--repo OWNER/NAME]
 * 环境变量：GH_TOKEN / GITHUB_TOKEN（可选，提高 API 限额）
 *           DSH_UPSTREAM_REPO（逗号分隔多仓库，靠后者优先；默认 cliii-one/DSH_FNOS,yoqie/DSH_FNOS）
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fetchUpstreamNote } from './upstream-note.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const REPO = opt('--repo', process.env.REPO || 'yoqie/FFFFFFFFNNNN');
const SLUG = 'dsh';
// 列表靠后的仓库优先级更高：同名版本以靠后的仓库为准。
// 最后一项是本仓库自己从上游 deepseek-ai/deepseek-harness 构建发布的 fpk
// （tag 形如 dsh-0.2.1-rc.2），优先级最高：自己出过包就用自己那份。
const UPSTREAM_REPOS = (process.env.DSH_UPSTREAM_REPO
  || REPO)
  .split(',').map((s) => s.trim()).filter(Boolean);

// —— 最上游作者（固定写死）——
// DSH 本体是 deepseek-ai/deepseek-harness；cliii-one/DSH_FNOS（及其 fork）只是把它
// 打包成 fpk 的仓库，因此索引里的作者写最上游，不随打包仓库的署名变化。
const MAINTAINER = 'deepseek-ai';
// DSH 官方上游仓库：用于取该版本的上游更新说明
const UPSTREAM_NOTE_REPO = 'deepseek-ai/deepseek-harness';
const MAINTAINER_URL = 'https://github.com/deepseek-ai/deepseek-harness';

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const HEADERS = { 'User-Agent': 'FnDepot-sync', Accept: 'application/vnd.github+json' };
if (TOKEN) HEADERS.Authorization = `Bearer ${TOKEN}`;

const readJson = async (p, d) => JSON.parse(await fs.readFile(p, 'utf8').catch(() => JSON.stringify(d)));
const writeJson = (p, o) => fs.writeFile(p, JSON.stringify(o, null, 2) + '\n');

// 只对"语义内容"取指纹：忽略 download_url 指向本源还是上游（sync 重置成上游、mirror
// 再改回本源，只是同一次运行内的中间态），也忽略 updated_at 自身。指纹没变就不写文件，
// 定时任务因此不会每天产生一条只改时间戳的空提交。
const fingerprint = (d) => JSON.stringify({
  meta: [d.app_name, d.display_name, d.desc, d.categories, d.maintainer, d.maintainer_url, d.service_port],
  releases: Object.entries(d.releases || {}).sort().map(([v, rel]) => [
    v,
    rel.release_note,
    rel.updated_at,
    Object.entries(rel.packages || {}).sort().map(([arch, p]) => [arch, p.version, p.sha256, p.size]),
  ]),
});

async function ghJson(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`GitHub API ${url} -> HTTP ${r.status}`);
  return r.json();
}

// 资产后缀 → FnDepot 包架构键。all 为旧工作流的历史产物（arm64 运行器单架构构建）
const ARCH_MAP = { amd64: 'x86', x64: 'x86', arm64: 'arm', aarch64: 'arm', all: 'arm' };

// 版本比较（semver 语义）：
//   主版本段逐段比较；无先行版 > 有先行版（0.2.0 > 0.2.0-rc.1）；
//   两个先行版之间逐段比较，段数多者更大（0.2.1-alpha.4.1 > 0.2.1-alpha.4），
//   同时仍低于下一个上游段（0.2.1-alpha.4.1 < 0.2.1-alpha.5）。
function versionCompare(a, b) {
  const split = (v) => {
    const s = String(v).replace(/^v/, '');
    const dash = s.indexOf('-');
    return {
      core: (dash === -1 ? s : s.slice(0, dash)).split('.'),
      pre: dash === -1 ? null : s.slice(dash + 1).split('.'),
    };
  };
  const num = (x) => (/^\d+$/.test(x) ? Number(x) : x);
  const cmpSeg = (x, y) => {
    const x1 = num(x);
    const y1 = num(y);
    if (x1 === y1) return 0;
    const xn = typeof x1 === 'number';
    const yn = typeof y1 === 'number';
    if (xn && yn) return x1 < y1 ? -1 : 1;
    if (xn !== yn) return xn ? 1 : -1; // 数字标识符 > 字母标识符
    return x1 < y1 ? -1 : 1;
  };
  const A = split(a);
  const B = split(b);
  for (let i = 0; i < Math.max(A.core.length, B.core.length); i += 1) {
    const c = cmpSeg(A.core[i] ?? '0', B.core[i] ?? '0');
    if (c) return c;
  }
  if (A.pre === null && B.pre === null) return 0;
  if (A.pre === null) return 1; // 正式版 > 先行版
  if (B.pre === null) return -1;
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i += 1) {
    if (A.pre[i] === undefined) return -1; // 先行版段数少者更小
    if (B.pre[i] === undefined) return 1;
    const c = cmpSeg(A.pre[i], B.pre[i]);
    if (c) return c;
  }
  return 0;
}

async function sha256Of(url) {
  // 兜底路径：Release 资产缺 digest 字段时下载后计算（正常不会走到）
  const r = await fetch(url, { headers: { 'User-Agent': 'FnDepot-sync' } });
  if (!r.ok) throw new Error(`下载失败 ${url} -> HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function fetchAllReleases() {
  const all = [];
  for (const repo of UPSTREAM_REPOS) {
    // 仓库不存在/已删除时只跳过它，不要让整条同步链失败
    try {
      for (let page = 1; ; page += 1) {
        const rels = await ghJson(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`);
      for (const r of rels) {
        // 本仓库里还挂着 1panel / Router2API 的 Release，只认 dsh-<版本> 这种 tag
        if (repo === REPO && !String(r.tag_name).startsWith(`${SLUG}-`)) continue;
        all.push({ ...r, __repo: repo });
      }
        if (!Array.isArray(rels) || rels.length < 100) break;
      }
    } catch (e) {
      if (/HTTP 404/.test(e.message)) {
        console.log(`跳过不存在的上游仓库：${repo}`);
        continue;
      }
      throw e;
    }
  }
  return all.filter((r) => !r.draft);
}

function packagesFromAssets(rel) {
  const specific = new Map(); // 优先 _amd64 / _arm64
  const fallback = new Map(); // 兜底 _all（历史单架构）
  for (const a of rel.assets || []) {
    const m = a.name.match(/_(amd64|x64|arm64|aarch64|all)\.fpk$/i);
    if (!m) continue;
    const suffix = m[1].toLowerCase();
    const arch = ARCH_MAP[suffix];
    if (!arch || specific.has(arch) || fallback.has(arch)) continue;
    const pkg = {
      version: rel.tag_name.replace(/^v/, '').replace(new RegExp(`^${SLUG}-`), ''),
      download_url: a.browser_download_url,
      sha256: a.digest && a.digest.startsWith('sha256:') ? a.digest.slice('sha256:'.length) : null,
      size: a.size,
    };
    (suffix === 'all' ? fallback : specific).set(arch, pkg);
  }
  return specific.size > 0 ? specific : fallback;
}

const releases = await fetchAllReleases();
const detailPath = path.join(ROOT, 'apps', `${SLUG}.json`);
await fs.mkdir(path.dirname(detailPath), { recursive: true });
const detail = await readJson(detailPath, {
  app_name: SLUG,
  display_name: 'DSH',
  desc: 'DeepSeek Harness（DSH）飞牛NAS版：自动跟进上游最新版本构建，amd64/arm64 双架构原生安装包，飞牛桌面一键打开。',
  categories: ['AI赋能', '编程开发'],
  maintainer: 'cliii-one',
  maintainer_url: `https://github.com/${UPSTREAM_REPOS[0]}`,
  run_as: 'root',
  install_type: 'root',
  is_docker: false,
  service_port: '3082',
  releases: {},
});

// 改动指纹要在任何"归位/重置"之前取，作为"内容有没有真的变"的基准
const beforeFp = fingerprint(detail);

// 作者归位到最上游（deepseek-ai/deepseek-harness）
if (detail.maintainer !== MAINTAINER || detail.maintainer_url !== MAINTAINER_URL) {
  console.log(`作者归位：${detail.maintainer || '(空)'} → ${MAINTAINER}（最上游）`);
}
detail.maintainer = MAINTAINER;
detail.maintainer_url = MAINTAINER_URL;

let synced = 0;
for (const rel of releases) {
  const packages = packagesFromAssets(rel);
  if (packages.size === 0) continue;
  const version = rel.tag_name.replace(/^v/, '').replace(new RegExp(`^${SLUG}-`), '');
  for (const [arch, pkg] of packages) {
    if (!pkg.sha256) {
      console.log(`${version} ${arch}: 资产缺少 digest，回退为下载计算 sha256`);
      pkg.sha256 = await sha256Of(pkg.download_url);
    }
  }
  // 更新信息直接同步上游该版本的 Release 正文；取不到时回退为默认说明。
  const upstreamNote = await fetchUpstreamNote(UPSTREAM_NOTE_REPO, version, {
    tags: ['dsh-v{v}', 'v{v}', '{v}'],
    maxLen: 6000,
  });
  const note = upstreamNote
    ? upstreamNote
    : `DSH v${version} 飞牛 fnOS 自动构建（${[...packages.keys()].sort().join('/')}）。`;
  // 同版本先删后加：保证键序保持"旧→新"，且以最新一次构建的资产为准
  delete detail.releases[version];
  detail.releases[version] = {
    version,
    release_note: note,
    updated_at: rel.published_at || rel.created_at,
    packages: Object.fromEntries(packages),
  };
  synced += 1;
}

if (synced === 0) throw new Error(`上游 ${UPSTREAM_REPOS.join(' + ')} 没有可用的 fpk Release`);

const latest = Object.keys(detail.releases).sort(versionCompare).pop();
// 键序统一为"旧→新"（与原 deepseek-harness.json 一致，最后一个为最新版）
const ordered = Object.keys(detail.releases).sort(versionCompare);
// 索引里只保留最新 KEEP_VERSIONS 个版本（默认 1）：
// 历史版本的包不在本源镜像里（指向上游单架构 _all.fpk，x86 机器装了会出错），
// 对应的 Release 也已由 prune-releases.mjs 清理，留在列表里只会让应用中心变乱。
const KEEP_VERSIONS = Number(process.env.DSH_KEEP_VERSIONS || '1');
const kept = KEEP_VERSIONS > 0 ? ordered.slice(-KEEP_VERSIONS) : ordered;
const dropped = ordered.slice(0, Math.max(0, ordered.length - kept.length));
const sortedReleases = {};
for (const v of kept) sortedReleases[v] = detail.releases[v];
detail.releases = sortedReleases;
if (dropped.length) {
  console.log(`索引只保留最新 ${kept.length} 个版本，移除历史条目：${dropped.join(', ')}`);
}
// 语义内容没变就别动文件：磁盘上保留的是本源镜像地址，硬写会把它改回上游并刷新
// updated_at，让定时任务提交一条空改动。
if (fingerprint(detail) !== beforeFp) {
  detail.updated_at = new Date().toISOString();
  await writeJson(detailPath, detail);
  console.log(`apps/${SLUG}.json 已更新（最新 ${latest}）`);
} else {
  console.log(`apps/${SLUG}.json 无变化（最新 ${latest}），保持本源下载地址不动`);
}

const meta = {
  slug: SLUG,
  displayName: 'DSH',
  desc: detail.desc,
  version: latest,
  categories: detail.categories,
  maintainer: detail.maintainer,
  maintainer_url: detail.maintainer_url,
  service_port: detail.service_port,
  run_as: 'root',
  install_type: 'root',
  is_docker: false,
};
await fs.mkdir(path.join(ROOT, 'build', SLUG), { recursive: true });
await writeJson(path.join(ROOT, 'build', SLUG, 'meta.json'), meta);

console.log(`同步完成：${synced} 个版本，最新 ${latest}（来自 ${UPSTREAM_REPOS.join(' + ')}）`);
