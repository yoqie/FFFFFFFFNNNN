#!/usr/bin/env node
/**
 * sync-router2api.mjs —— 同步 Router2API（.NET 10 模型路由宿主 · 飞牛原生包）到 FnDepot 索引
 *
 * 上游数据源（GitHub Releases）：
 *   cliii-one/Router2API —— 飞牛 fnOS 打包仓库（Router2API_v<版本>_amd64.fpk / _arm64.fpk）
 *
 * 最上游作者：
 *   宿主项目本体是 NNNNolan/Router2API（cliii-one/Router2API 只是把它打包成 fpk），
 *   因此索引里的 maintainer / maintainer_url 固定写最上游作者 NNNNolan，
 *   不走上游 manifest 里的打包者署名（Router2API-fnos）。每次同步都会强制覆盖，
 *   避免上游改署名后索引跟着漂移。
 *
 * 产出：
 *   apps/Router2API.json        应用详情（releases[].packages: x86/arm 下载地址 + sha256 + size）
 *   build/Router2API/meta.json  应用元数据（供 update-index.mjs 重建 fnpack.json / README.md）
 *
 * 注意：本脚本会把 download_url 重置为上游 Release 地址；工作流随后运行
 * scripts/mirror-router2api.mjs 把最新版 fpk 镜像到本源 Release 并改回本源地址。
 *
 * 用法：node scripts/sync-router2api.mjs [--repo OWNER/NAME]
 * 环境变量：GH_TOKEN / GITHUB_TOKEN（可选，提高 API 限额）
 *           ROUTER2API_UPSTREAM_REPO（默认 cliii-one/Router2API）
 *           ROUTER2API_KEEP_VERSIONS（索引保留版本数，默认 1）
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const REPO = opt('--repo', process.env.REPO || 'yoqie/FFFFFFFFNNNN');
const SLUG = 'Router2API';
// 列表靠后的仓库优先级更高：同名版本以靠后的仓库为准。
// 最后一项是本仓库自己构建发布的 fpk（tag 形如 Router2API-2.0.9），优先级最高：
// 只要本仓库自己出过包，索引就用自己那份，不再依赖第三方打包方是否跟上上游。
const UPSTREAM_REPOS = (process.env.ROUTER2API_UPSTREAM_REPO
  || `cliii-one/Router2API,yoqie/Router2API,${REPO}`)
  .split(',').map((s) => s.trim()).filter(Boolean);

// —— 最上游作者（固定写死，不被上游 manifest 的打包者署名覆盖）——
const MAINTAINER = 'NNNNolan';
const MAINTAINER_URL = 'https://github.com/NNNNolan/Router2API';
const DISPLAY_NAME = 'Router2API';
const DESC = '.NET 10 模型路由宿主，把不同提供方的模型统一成 OpenAI 兼容接口，自带 Vue 3 管理后台。包内集成 .NET 自包含运行时与 Redis 运行态，安装即用，无需 Docker。';
const CATEGORIES = ['AI赋能', '编程开发'];
const SERVICE_PORT = '5242';

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const HEADERS = { 'User-Agent': 'FnDepot-sync', Accept: 'application/vnd.github+json' };
if (TOKEN) HEADERS.Authorization = `Bearer ${TOKEN}`;

const readJson = async (p, d) => JSON.parse(await fs.readFile(p, 'utf8').catch(() => JSON.stringify(d)));
const writeJson = (p, o) => fs.writeFile(p, JSON.stringify(o, null, 2) + '\n');

// 只对"语义内容"取指纹：忽略 download_url 指向本源还是上游（sync 会重置成上游、
// mirror 再改回本源，这只是同一次运行内的中间态），也忽略 updated_at 自身。
// 指纹没变就不写文件，定时任务因此不会每天产生一条只改时间戳的空提交。
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

// 资产后缀 → FnDepot 包架构键。all 为旧工作流的历史产物（单架构构建）
const ARCH_MAP = { amd64: 'x86', x64: 'x86', arm64: 'arm', aarch64: 'arm', all: 'arm' };

// 版本比较（semver 语义）：
//   主版本段逐段比较；无先行版 > 有先行版（2.1.0 > 2.1.0-rc.1）；
//   两个先行版之间逐段比较，段数多者更大。
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
    // 允许列表里存在"还没建/已删除"的仓库（例如自己那套打包 fork 还没 fork 出来），
    // 命中 404 只跳过它，不要让整条同步链失败。
    try {
      for (let page = 1; ; page += 1) {
        const rels = await ghJson(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`);
        for (const r of rels) {
          // 本仓库里还挂着 dsh / 1panel 的 Release，只认 Router2API-<版本> 这种 tag
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
  display_name: DISPLAY_NAME,
  desc: DESC,
  categories: CATEGORIES,
  maintainer: MAINTAINER,
  maintainer_url: MAINTAINER_URL,
  run_as: 'root',
  install_type: 'root',
  is_docker: false,
  service_port: SERVICE_PORT,
  releases: {},
});

// 改动指纹要在任何"归位/重置"之前取，作为"内容有没有真的变"的基准
const beforeFp = fingerprint(detail);

// 作者/上游信息每次强制归位到最上游，防止历史文件或上游署名把索引带偏
if (detail.maintainer !== MAINTAINER || detail.maintainer_url !== MAINTAINER_URL) {
  console.log(`作者归位：${detail.maintainer || '(空)'} → ${MAINTAINER}（最上游）`);
}
detail.maintainer = MAINTAINER;
detail.maintainer_url = MAINTAINER_URL;
if (!detail.desc) detail.desc = DESC;
if (!detail.categories) detail.categories = CATEGORIES;
if (!detail.service_port) detail.service_port = SERVICE_PORT;

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
  const note = rel.__repo === REPO
    ? `Router2API v${version} 飞牛 fnOS 原生包（${[...packages.keys()].sort().join('/')}），由本源从上游 ${MAINTAINER} 的最新源码自动构建。`
    : `Router2API v${version} 飞牛 fnOS 原生包（${[...packages.keys()].sort().join('/')}），由 ${rel.__repo} 自动打包；宿主上游见 ${MAINTAINER_URL}。`;
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
// 键序统一为"旧→新"，最后一个为最新版
const ordered = Object.keys(detail.releases).sort(versionCompare);
// 索引里只保留最新 KEEP_VERSIONS 个版本（默认 1）：历史版本的包不在本源镜像里，
// 对应的 Release 也已由 prune-releases.mjs 清理，留在列表里只会让应用中心变乱。
const KEEP_VERSIONS = Number(process.env.ROUTER2API_KEEP_VERSIONS || '1');
const kept = KEEP_VERSIONS > 0 ? ordered.slice(-KEEP_VERSIONS) : ordered;
const dropped = ordered.slice(0, Math.max(0, ordered.length - kept.length));
const sortedReleases = {};
for (const v of kept) sortedReleases[v] = detail.releases[v];
detail.releases = sortedReleases;
if (dropped.length) {
  console.log(`索引只保留最新 ${kept.length} 个版本，移除历史条目：${dropped.join(', ')}`);
}
// 语义内容没变就别动文件：此刻磁盘上保留的正是本源镜像地址，硬写会把它改回上游，
// 并顺带刷新 updated_at，让工作流误判成"有新版本"而提交一条空改动。
if (fingerprint(detail) !== beforeFp) {
  detail.updated_at = new Date().toISOString();
  await writeJson(detailPath, detail);
  console.log(`apps/${SLUG}.json 已更新（最新 ${latest}）`);
} else {
  console.log(`apps/${SLUG}.json 无变化（最新 ${latest}），保持本源下载地址不动`);
}

const meta = {
  slug: SLUG,
  displayName: DISPLAY_NAME,
  desc: detail.desc,
  version: latest,
  upstream: MAINTAINER_URL,
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

console.log(`同步完成：${synced} 个版本，最新 ${latest}（来自 ${UPSTREAM_REPOS.join(' + ')}，作者 ${MAINTAINER}）`);
