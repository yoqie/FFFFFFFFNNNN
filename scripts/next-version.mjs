#!/usr/bin/env node
// 计算本次要发布的版本号：跟随上游的同时，保证版本号**单调递增**。
//
// 为什么需要它：飞牛应用中心判断"可更新"是比较已安装版本与源里最新版本，
// 比较时会忽略 alpha / rc 这类字母段，只比数字段（例如 0.2.1-rc.2 视作 0.2.1.2）。
// 因此源里如果出现"数字段不比已安装的大"的版本，用户就永远收不到更新提示。
//
// 规则：
//   base    = 上游版本去掉字母段后的数字串        0.2.1-rc.2 → 0.2.1.2 ；2.0.9 → 2.0.9
//   highest = 已发布过的最高版本（取本仓库的 Release tag + 高水位文件
//             build/<slug>/highest-version.txt，取不到则退回 apps/<slug>.json）
//   version = base                 当 base > highest
//           = base.<k>             k 取最小正整数，使 base.k > highest
//
// --keep-upstream（DSH 用）：输出保留上游原版本号字符串，需要递增时在**上游字符串**后面补段，
// 这样版本号既能和上游 Release 对照，又满足飞牛的数字段比较：
//   上游 0.2.2-alpha.2，已发布最高 0.2.2-alpha.2 → 0.2.2-alpha.2.1（数字段 0.2.2.2.1 > 0.2.2.2）
//
// 高水位文件的意义：prune-releases 会删掉旧 Release，索引里也只留最新一版，
// 一旦索引被写坏（曾经发生过版本倒退），"已发布过什么"就失忆了。高水位只增不减，
// 保证任何情况下都不会再发布一个比历史更低的版本。
//
// 用法：
//   node scripts/next-version.mjs --slug Router2API --upstream-version 2.1.2
//   node scripts/next-version.mjs --slug dsh --upstream-version 0.2.2-alpha.2 --keep-upstream
// 输出（stdout）：最终版本号；细节打到 stderr，便于日志查看。
//
// 说明：对"同一上游版本重发"（如打包修复后强制重建），会得到 base.1 / base.2 这样的
// 递增版本，用户才能收到这次更新；而上游下一次发新版时，base 本身就会更大并直接采用。

import fs from 'node:fs';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const slug = arg('slug');
const upstream = arg('upstream-version').replace(/^v/, '');
const keepUpstream = process.argv.includes('--keep-upstream');
if (!slug || !upstream) {
  console.error('用法: node scripts/next-version.mjs --slug <slug> --upstream-version <上游版本> [--keep-upstream]');
  process.exit(1);
}

const repo = process.env.GITHUB_REPOSITORY || arg('repo', 'yoqie/FFFFFFFFNNNN');
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

// 与飞牛一致的比较方式：只取数字段，缺失的位按 0 算
const nums = (v) => String(v).split(/[^0-9]+/).filter((s) => s !== '').map(Number);
function cmp(a, b) {
  const A = nums(a), B = nums(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i] || 0, y = B[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}
// 上游版本 → 纯数字版本
const base = nums(upstream).join('.');
if (!base) {
  console.error(`无法从上游版本得到数字段: ${upstream}`);
  process.exit(1);
}

// 已发布版本：Release tag（最权威）+ 高水位文件 + 索引，三者取并集。
// 任何单一来源都可能失忆（Release 会被 prune、索引只留最新一版），并集才安全。
const HIGH_WATER = `build/${slug}/highest-version.txt`;
async function publishedVersions() {
  const out = new Set();
  if (token) {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      });
      if (res.ok) {
        for (const r of await res.json()) {
          const t = String(r.tag_name || '');
          if (t.startsWith(`${slug}-`)) out.add(t.slice(slug.length + 1));
        }
      }
    } catch (e) {
      console.error(`读取 Release 列表失败，改用索引：${e.message}`);
    }
  }
  try {
    const hw = fs.readFileSync(HIGH_WATER, 'utf8').trim();
    if (hw) out.add(hw.replace(/^v/, ''));
  } catch {
    /* 还没有高水位文件 */
  }
  try {
    const idx = JSON.parse(fs.readFileSync(`apps/${slug}.json`, 'utf8'));
    for (const v of Object.keys(idx.releases || {})) out.add(v);
  } catch {
    /* 索引还不存在 */
  }
  return [...out];
}

const versions = await publishedVersions();
const highest = versions.reduce((a, b) => (cmp(b, a) > 0 ? b : a), '');

let version;
if (keepUpstream) {
  // 保留上游字符串：能直接用上游版本就用，需要递增时在上游字符串后补 .k
  if (!highest || cmp(base, highest) > 0) {
    version = upstream;
  } else {
    let k = 1;
    while (cmp(`${base}.${k}`, highest) <= 0) k++;
    version = `${upstream}.${k}`;
  }
} else {
  version = base;
  if (highest && cmp(base, highest) <= 0) {
    // base 不比已发布的最高版本大，需要递增。
    // 两种情况区别对待，避免版本号越堆越长：
    //   1) 数字段完全相同（同一上游版本重发）→ 递增最后一段：0.2.1.2 → 0.2.1.3
    //   2) base 更短/更小（如上游发正式版 0.2.1 而源里已有 0.2.1.2）
    //      → 在 base 后补段直到超过 highest：0.2.1 → 0.2.1.3
    if (cmp(base, highest) === 0) {
      const parts = base.split('.').map(Number);
      parts[parts.length - 1] += 1;
      version = parts.join('.');
    } else {
      let k = 1;
      while (cmp(`${base}.${k}`, highest) <= 0) k++;
      version = `${base}.${k}`;
    }
  }
}

console.error(
  `上游版本 ${upstream} → 数字段 ${base}；已发布最高 ${highest || '（无）'}；本次发布版本 ${version}`,
);
console.log(version);
