#!/usr/bin/env node
// 维护「已发布过的最高版本」高水位：只增不减，写进 build/<slug>/highest-version.txt。
//
// 为什么需要：next-version.mjs 靠"已发布过什么"决定要不要递增版本号，
// 但 Release 会被 prune-releases 删掉、apps/<slug>.json 只保留最新一版，
// 一旦索引被写坏（曾经把 0.2.2-alpha.2 写成 0.2.1-rc.5），就没人记得发过更高版本了。
// 高水位文件进 git，是唯一不会被清理动作影响的历史记录。
//
// 用法：
//   node scripts/bump-high-water.mjs --slug dsh --version 0.2.2-alpha.2.1
// 输出（stdout）：写入后的高水位；细节打到 stderr。

import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const slug = arg('slug');
const version = arg('version').replace(/^v/, '');
if (!slug || !version) {
  console.error('用法: node scripts/bump-high-water.mjs --slug <slug> --version <版本>');
  process.exit(1);
}

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

const file = path.join('build', slug, 'highest-version.txt');
let prev = '';
try {
  prev = fs.readFileSync(file, 'utf8').trim();
} catch {
  /* 首次写入 */
}

if (prev && cmp(version, prev) < 0) {
  console.error(`拒绝降低高水位：已有 ${prev}，本次 ${version} 更低，保持 ${prev}`);
  console.log(prev);
  process.exit(0);
}

const next = prev && cmp(version, prev) <= 0 ? prev : version;
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `${next}\n`);
console.error(`高水位：${prev || '（无）'} → ${next}`);
console.log(next);
