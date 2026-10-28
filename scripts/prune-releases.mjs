#!/usr/bin/env node
/**
 * prune-releases.mjs —— 某个应用发布新版本后，自动删除本仓库里该应用的旧 Release
 *
 * 背景：1Panel / Router2API 每跟随上游发一次版就会新建一个 Release（tag: <slug>-<版本>），
 * 每个包 60~170MB，旧版本长期堆积。本脚本在**新版发布成功之后**执行清理：
 *   1. 列出 tag 以 <slug>- 开头的 Release，按创建时间保留最新 N 个（默认 1）
 *   2. 删除其余 Release（并尽力删除对应的 git tag）
 *   3. 清理 apps/<slug>.json 里指向这些已删除 Release 的下载条目——
 *      否则索引会一直挂着一个 404 的下载地址
 *
 * 用法：
 *   node scripts/prune-releases.mjs --slug 1panel --keep-tag 1panel-2.3.2-2
 *   node scripts/prune-releases.mjs --slug Router2API
 *   node scripts/prune-releases.mjs --slug 1panel --keep 2      # 想多留一个旧版就 --keep 2
 *   node scripts/prune-releases.mjs --slug dsh --keep-tag dsh-0.2.2-alpha.2 --prune-assets
 *   node scripts/prune-releases.mjs --slug 1panel --dry-run      # 只打印计划
 *
 * --prune-assets：额外清掉「保留 Release 里已不被 apps/<slug>.json 引用」的旧资产
 *   （产物名带内容指纹后，重建一次就会多一份）。--asset-min-age-minutes 默认 60，
 *   这段时间内的旧资产会留着，给还在用旧索引的客户端缓冲。
 *   索引里没有任何下载条目时跳过，绝不误删。
 *
 * 环境变量：GH_TOKEN / GITHUB_TOKEN（需 contents:write）、REPO（默认 yoqie/FFFFFFFFNNNN）
 *
 * 安全护栏：如果被保留的 Release 一个资产都没有，直接报错退出，绝不删旧版。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const SLUG = opt('--slug', '');
const KEEP = Math.max(1, Number(opt('--keep', '1')) || 1);
const KEEP_TAG = opt('--keep-tag', '');
const REPO = opt('--repo', process.env.REPO || 'yoqie/FFFFFFFFNNNN');
const DRY = has('--dry-run');
// 产物名带内容指纹后，重建一次就多一个资产；索引只指向当前那份。
// 打开这个开关就把「保留 Release 里已不被索引引用」的旧资产删掉，
// 只保留 ASSET_MIN_AGE 分钟内的（给还在用旧索引的客户端留缓冲）。
const PRUNE_ASSETS = has('--prune-assets');
const ASSET_MIN_AGE_RAW = Number(opt('--asset-min-age-minutes', '60'));
const ASSET_MIN_AGE = Number.isFinite(ASSET_MIN_AGE_RAW) ? Math.max(0, ASSET_MIN_AGE_RAW) : 60;
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

if (!SLUG) {
  console.error('用法: node scripts/prune-releases.mjs --slug <slug> [--keep N] [--keep-tag TAG] [--dry-run]');
  process.exit(1);
}
if (!TOKEN && !DRY) {
  console.error('缺少 GH_TOKEN / GITHUB_TOKEN（需要 contents:write）');
  process.exit(1);
}

const API = 'https://api.github.com';
const UA = 'FnDepot-prune';

function ghHeaders(json) {
  const h = { 'User-Agent': UA, Accept: 'application/vnd.github+json' };
  if (json) h['Content-Type'] = 'application/json';
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

async function api(method, endpoint, body) {
  const url = endpoint.startsWith('http') ? endpoint : API + endpoint;
  const r = await fetch(url, {
    method,
    headers: ghHeaders(!!body),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 404) return null;
  const text = await r.text();
  if (!r.ok) throw new Error(`GitHub API ${method} ${endpoint} -> HTTP ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function listReleases() {
  const all = [];
  for (let page = 1; page <= 10; page += 1) {
    const list = await api('GET', `/repos/${REPO}/releases?per_page=100&page=${page}`);
    if (!list || list.length === 0) break;
    all.push(...list);
    if (list.length < 100) break;
  }
  return all;
}

const prefix = `${SLUG}-`;
const mine = (await listReleases()).filter((r) => (r.tag_name || '').startsWith(prefix));
mine.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

if (mine.length === 0) {
  console.log(`${SLUG}: 本源还没有该应用的 Release，无需清理`);
  process.exit(0);
}

const keep = new Set(mine.slice(0, KEEP).map((r) => r.tag_name));
if (KEEP_TAG) {
  if (!mine.some((r) => r.tag_name === KEEP_TAG)) {
    console.error(`找不到要保留的 Release: ${KEEP_TAG}，为安全起见不删除任何旧版本`);
    process.exit(1);
  }
  keep.add(KEEP_TAG);
}

// 安全护栏：保留的 Release 必须真的有资产，否则宁可什么都不删
for (const tag of keep) {
  const rel = mine.find((r) => r.tag_name === tag);
  const uploaded = (rel.assets || []).filter((a) => a.state === 'uploaded');
  if (uploaded.length === 0) {
    console.error(`保留的 Release ${tag} 没有任何已上传资产，拒绝删除旧版本`);
    process.exit(1);
  }
}

const drop = mine.filter((r) => !keep.has(r.tag_name));
console.log(`${SLUG}: 共 ${mine.length} 个 Release，保留 ${[...keep].join(', ')}，待删除 ${drop.length} 个${DRY ? '（dry-run）' : ''}`);

for (const rel of drop) {
  const size = (rel.assets || []).reduce((n, a) => n + (a.size || 0), 0);
  if (DRY) {
    console.log(`[dry-run] 将删除 Release ${rel.tag_name}（${(rel.assets || []).length} 个资产，${(size / 1024 / 1024).toFixed(1)}MB）`);
    continue;
  }
  await api('DELETE', `/repos/${REPO}/releases/${rel.id}`);
  try {
    await api('DELETE', `/repos/${REPO}/git/refs/tags/${encodeURIComponent(rel.tag_name)}`);
  } catch (e) {
    console.warn(`  标签 ${rel.tag_name} 清理失败（不影响发布）: ${e.message}`);
  }
  console.log(`已删除 Release ${rel.tag_name}（${(size / 1024 / 1024).toFixed(1)}MB）`);
}

// ---- 校验索引：清理"指向本仓库、但 Release 或资产已不存在"的下载条目 ----
// 这里不是只认本次删掉的 tag，而是拿删除后的真实 Release 列表逐条核对，
// 所以历史遗留的失效地址（比如手工删过 Release、或本地索引落后）也会被自动修好。
const aliveSource = DRY
  ? mine.filter((r) => !drop.some((d) => d.tag_name === r.tag_name))
  : await listReleases();
const alive = new Map(aliveSource.map((r) => [
  r.tag_name,
  new Set((r.assets || []).filter((a) => a.state === 'uploaded').map((a) => a.name)),
]));

const indexPath = path.join(ROOT, 'apps', `${SLUG}.json`);
const raw = await fs.readFile(indexPath, 'utf8').catch(() => null);
if (raw) {
  const detail = JSON.parse(raw);
  let removedPkgs = 0;
  let removedEntries = 0;
  for (const [ver, rel] of Object.entries(detail.releases || {})) {
    for (const [arch, pkg] of Object.entries(rel.packages || {})) {
      const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/(.+)$/.exec(pkg.download_url || '');
      if (!m || m[1].toLowerCase() !== REPO.toLowerCase()) continue; // 上游地址不归我们管
      const tag = decodeURIComponent(m[2]);
      const asset = decodeURIComponent(m[3]);
      const assets = alive.get(tag);
      let reason = '';
      if (!assets) reason = `Release ${tag} 已不存在`;
      else if (!assets.has(asset)) reason = `Release ${tag} 里已没有 ${asset}`;
      if (!reason) continue;
      delete rel.packages[arch];
      removedPkgs += 1;
      console.log(`索引清理: apps/${SLUG}.json ${ver}/${arch} → ${reason}`);
    }
    if (Object.keys(rel.packages || {}).length === 0) {
      delete detail.releases[ver];
      removedEntries += 1;
    }
  }
  if (removedPkgs > 0 && !DRY) {
    await fs.writeFile(indexPath, JSON.stringify(detail, null, 2) + '\n');
  }
  if (removedPkgs > 0) {
    console.log(`apps/${SLUG}.json: 清理 ${removedPkgs} 个下载条目、${removedEntries} 个空版本条目${DRY ? '（dry-run 未写入）' : ''}`);
  } else {
    console.log(`apps/${SLUG}.json: 无需清理（${Object.keys(detail.releases || {}).length} 个版本条目全部有效）`);
  }
}

// ---- 清理保留 Release 里「已不被索引引用」的旧资产 ----
// 只在 --prune-assets 时执行：索引里的 size/sha256 是安装校验的依据，
// 删掉仍被引用的资产等于发布一个 404，所以只删索引没提到的那些。
if (PRUNE_ASSETS) {
  const detailRaw = await fs.readFile(indexPath, 'utf8').catch(() => null);
  const referenced = new Set();
  if (detailRaw) {
    for (const rel of Object.values(JSON.parse(detailRaw).releases || {})) {
      for (const pkg of Object.values(rel.packages || {})) {
        const m = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/([^/]+)\/(.+)$/.exec(pkg.download_url || '');
        if (m) referenced.add(`${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`);
      }
    }
  }
  if (referenced.size === 0) {
    console.warn('索引里没有任何下载条目，跳过资产清理（避免误删）');
  } else {
    const cutoff = Date.now() - ASSET_MIN_AGE * 60000;
    for (const rel of aliveSource) {
      if (!keep.has(rel.tag_name)) continue;
      for (const a of rel.assets || []) {
        if (a.state && a.state !== 'uploaded') continue;
        if (referenced.has(`${rel.tag_name}/${a.name}`)) continue;
        const ts = Date.parse(a.created_at || a.updated_at || '') || 0;
        if (ts > cutoff) {
          console.log(`保留资产 ${a.name}（${Math.round((Date.now() - ts) / 60000)} 分钟前上传，等旧索引自然过期）`);
          continue;
        }
        if (DRY) { console.log(`[dry-run] 将删除资产 ${a.name}`); continue; }
        await api('DELETE', `/repos/${REPO}/releases/assets/${a.id}`);
        console.log(`已删除资产 ${a.name}（${((a.size || 0) / 1048576).toFixed(1)}MB，已不被索引引用）`);
      }
    }
  }
}

console.log('prune done.');
