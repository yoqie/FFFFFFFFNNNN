#!/usr/bin/env node
/**
 * mirror-dsh.mjs —— 把 DSH 的 fpk 镜像到本源 Release，让 DSH 像 1panel 一样显示在 Releases
 *
 * 背景：DSH 的 fpk 现在由本源（FFFFFFFFNNN）直接从上游 deepseek-ai/deepseek-harness 构建并发布；
 *       对第三方/其他 fork 的历史 Release 仍可镜像，索引里的下载地址统一指向本源。
 * 现在本源把 fpk 二次分发到自己的 Release（tag: dsh-<version>），
 * apps/dsh.json 里的下载地址随之指向本源，不再依赖上游仓库。
 *
 * 运行顺序（见 .github/workflows/dsh-sync.yml）：
 *   sync-dsh.mjs → mirror-dsh.mjs → update-index.mjs
 * sync-dsh.mjs 每次都会把 download_url 重置回上游地址，mirror-dsh.mjs 负责改回本源地址，
 * 因此本脚本是幂等的：已镜像且资产完整的版本直接跳过。
 *
 * 用法：
 *   node scripts/mirror-dsh.mjs            # 只镜像索引里的最新版本（默认）
 *   node scripts/mirror-dsh.mjs --all      # 镜像索引里的全部版本（首次全量补档用）
 *   node scripts/mirror-dsh.mjs --force    # 已存在同名同大小资产时也重新上传
 *   node scripts/mirror-dsh.mjs --dry-run  # 只打印计划，不创建 Release、不下载上传
 *
 * 环境变量：
 *   GH_TOKEN / GITHUB_TOKEN  必需（需 contents:write 权限），工作流里用 github.token
 *   REPO                     默认 yoqie/FFFFFFFFNNNN
 *
 * 依赖：curl（ubuntu-latest 与飞牛系统均自带），用于流式上传大文件，避免整包读入内存。
 */

import { promises as fs, createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const REPO = opt('--repo', process.env.REPO || 'yoqie/FFFFFFFFNNNN');
const SLUG = 'dsh';
const ALL = has('--all');
const FORCE = has('--force');
const DRY = has('--dry-run');
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

const API = 'https://api.github.com';
const UA = 'FnDepot-mirror';

const readJson = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));

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

// 与 sync-dsh.mjs 保持一致（semver 语义）：
//   0.2.0 正式版 > 0.2.0-rc.1 先行版；先行版段数多者更大
//   （0.2.1-alpha.4.1 > 0.2.1-alpha.4 且 < 0.2.1-alpha.5）。
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
    if (xn !== yn) return xn ? 1 : -1;
    return x1 < y1 ? -1 : 1;
  };
  const A = split(a);
  const B = split(b);
  for (let i = 0; i < Math.max(A.core.length, B.core.length); i += 1) {
    const c = cmpSeg(A.core[i] ?? '0', B.core[i] ?? '0');
    if (c) return c;
  }
  if (A.pre === null && B.pre === null) return 0;
  if (A.pre === null) return 1;
  if (B.pre === null) return -1;
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i += 1) {
    if (A.pre[i] === undefined) return -1;
    if (B.pre[i] === undefined) return 1;
    const c = cmpSeg(A.pre[i], B.pre[i]);
    if (c) return c;
  }
  return 0;
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;

/** 流式下载并计算 sha256，避免大包进内存 */
async function download(url, dest) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!r.ok) throw new Error(`下载失败 ${url} -> HTTP ${r.status}`);
  const hash = crypto.createHash('sha256');
  let size = 0;
  const src = Readable.fromWeb(r.body);
  src.on('data', (c) => { hash.update(c); size += c.length; });
  await pipeline(src, createWriteStream(dest));
  return { sha256: hash.digest('hex'), size };
}

/** 用 curl 以 -T 流式上传（文件不读进内存），失败时带上响应体报错 */
function uploadAsset(releaseId, file, name) {
  const url = `https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
  const args = [
    '-sS', '--fail-with-body', '--retry', '3', '--retry-delay', '5',
    '-X', 'POST', '-T', file,
    '-H', `Authorization: Bearer ${TOKEN}`,
    '-H', 'Content-Type: application/octet-stream',
    '-H', 'Accept: application/vnd.github+json',
    url,
  ];
  let out;
  try {
    out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`上传 ${name} 失败: ${String(e.stdout || e.message).slice(0, 500)}`);
  }
  let json;
  try { json = JSON.parse(out); } catch { throw new Error(`上传 ${name} 返回非 JSON: ${out.slice(0, 300)}`); }
  if (!json.id) throw new Error(`上传 ${name} 未返回资产 id: ${out.slice(0, 300)}`);
  return json;
}

const ownPrefix = (tag) => `https://github.com/${REPO}/releases/download/${tag}/`;

const detailPath = path.join(ROOT, 'apps', `${SLUG}.json`);
const detail = await readJson(detailPath);
const allVersions = Object.keys(detail.releases || {});
if (allVersions.length === 0) throw new Error('apps/dsh.json 里没有 releases，先运行 sync-dsh.mjs');

const sorted = [...allVersions].sort(versionCompare);
const targets = ALL ? sorted : [sorted[sorted.length - 1]];
if (!TOKEN && !DRY) throw new Error('缺少 GH_TOKEN / GITHUB_TOKEN（需要 contents:write）');

console.log(`镜像目标：${targets.join(', ')} → ${REPO} Releases（${DRY ? 'dry-run' : '正式执行'}）`);

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-mirror-'));
let changed = 0;
const failed = [];

for (const version of targets) {
  const rel = detail.releases[version];
  const tag = `dsh-${version}`;
  const packages = Object.entries(rel.packages || {});

  try {
    for (const [arch, pkg] of packages) {
      const file = decodeURIComponent(new URL(pkg.download_url).pathname.split('/').pop());
      if (pkg.download_url.startsWith(ownPrefix(tag)) && !FORCE) {
        console.log(`${tag} ${arch}: 已是本源地址，跳过（${file}）`);
        continue;
      }
      if (DRY) {
        console.log(`[dry-run] ${tag} ${arch}: 将镜像 ${file} → ${ownPrefix(tag)}${file}`);
        continue;
      }

      let release = await api('GET', `/repos/${REPO}/releases/tags/${tag}`);
      if (!release) {
        release = await api('POST', `/repos/${REPO}/releases`, {
          tag_name: tag,
          name: `DSH ${version}`,
          body: rel.release_note || `DSH ${version} 飞牛 fnOS 安装包（本源镜像，上游 deepseek-ai/deepseek-harness）。`,
          draft: false,
          prerelease: false,
        });
        console.log(`${tag}: 已创建 Release`);
      }

      const existing = (release.assets || []).find((a) => a.name === file);
      // 本源已有同一资产（GitHub 计算的 sha256 与索引一致，或大小一致且索引无 sha）时
      // 无需重复下载几百 MB，直接改写下载地址即可
      const assetSha = existing && existing.digest ? existing.digest.replace(/^sha256:/, '') : null;
      const sameDigest = !!(assetSha && pkg.sha256 && assetSha === pkg.sha256);
      const sameSize = !!(existing && typeof pkg.size === 'number' && existing.size === pkg.size);
      if (existing && !FORCE && (sameDigest || (sameSize && !pkg.sha256))) {
        pkg.download_url = `${ownPrefix(tag)}${file}`;
        changed += 1;
        console.log(`${tag} ${arch}: 本源已有同一资产（${mb(existing.size)}），仅改写下载地址`);
        continue;
      }

      const dest = path.join(tmpRoot, file);
      console.log(`${tag} ${arch}: 下载 ${file} …`);
      const { sha256, size } = await download(pkg.download_url, dest);
      if (pkg.sha256 && sha256 !== pkg.sha256) {
        throw new Error(`sha256 校验失败 ${file}: 索引 ${pkg.sha256} ≠ 实际 ${sha256}`);
      }

      if (existing) {
        await api('DELETE', `/repos/${REPO}/releases/assets/${existing.id}`);
        console.log(`${tag} ${arch}: 已删除旧资产 ${file}`);
      }
      process.stdout.write(`${tag} ${arch}: 上传 ${file}（${mb(size)}）… `);
      uploadAsset(release.id, dest, file);
      process.stdout.write('完成\n');
      await fs.rm(dest, { force: true });

      pkg.download_url = `${ownPrefix(tag)}${file}`;
      pkg.sha256 = sha256;
      pkg.size = size;
      changed += 1;
    }
  } catch (e) {
    failed.push(`${tag}: ${e.message}`);
    console.error(`✗ ${tag}: ${e.message}`);
  }
}

await fs.rm(tmpRoot, { recursive: true, force: true });

if (changed > 0 && !DRY) {
  detail.updated_at = new Date().toISOString();
  await fs.writeFile(detailPath, JSON.stringify(detail, null, 2) + '\n');
  console.log(`apps/${SLUG}.json 已更新：${changed} 个包指向本源 Release`);
} else if (!DRY) {
  console.log('apps/dsh.json 无需改动');
}

if (failed.length > 0) {
  console.error(`镜像失败 ${failed.length} 项：\n- ${failed.join('\n- ')}`);
  process.exit(1);
}
console.log('mirror done.');
