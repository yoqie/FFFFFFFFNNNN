#!/usr/bin/env node
// 解析上游「最高版本」，而不是「最近发布」的那个版本。
//
// 为什么不能取列表第一个：上游会同时维护多条线（例如 0.2.1-rc.N 与 0.2.2-alpha.N），
// 老线上的补丁发布得**更晚**，按 published_at 排序时它排在前面。
// 曾经因此把源里的版本从 0.2.2-alpha.2 退回 0.2.1-rc.5 —— 版本号倒退，
// 飞牛应用中心认为"没有更新"，用户既收不到更新提示，也看不到更新内容。
//
// 比较方式与飞牛应用中心一致：只取数字段、缺失位按 0 补。
//   0.2.1-rc.5    → 0.2.1.5
//   0.2.2-alpha.2 → 0.2.2.2   ← 更高，即使发布得更早
//
// 用法：
//   node scripts/upstream-release.mjs --repo deepseek-ai/deepseek-harness --prefix dsh-v
// 输出（stdout）：最高上游版本（去掉前缀）；细节打到 stderr。
// 取不到任何 Release 时输出空行并以 1 退出，交由调用方决定回退策略。

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const repo = arg('repo', 'deepseek-ai/deepseek-harness');
const prefix = arg('prefix', 'dsh-v');
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

async function releases() {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  // per_page=100：上游当前只有几十个 dsh-v* Release，一页够用；
  // 万一以后超过，翻页只影响"最高版本"的完整性，不影响本次可用性。
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, { headers });
    if (!res.ok) {
      console.error(`读取上游 Release 失败（HTTP ${res.status}），已取到 ${out.length} 条`);
      break;
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

const all = await releases();
const versions = all
  .filter((r) => r && !r.draft && String(r.tag_name || '').startsWith(prefix))
  .map((r) => String(r.tag_name).slice(prefix.length));

if (versions.length === 0) {
  console.error(`上游 ${repo} 没有以 ${prefix} 开头的非草稿 Release`);
  console.log('');
  process.exit(1);
}

const highest = versions.reduce((a, b) => (cmp(b, a) > 0 ? b : a), '');
// 同时把"按发布时间的最新一个"记到日志，便于对照两者不一致时的排查
const newestByDate = String(all.find((r) => r && !r.draft && String(r.tag_name || '').startsWith(prefix))?.tag_name || '')
  .slice(prefix.length);
console.error(
  `上游 Release ${versions.length} 个；按版本最高 ${highest}（数字段 ${nums(highest).join('.')}）；` +
    `按发布时间最新 ${newestByDate || '（无）'}${newestByDate && newestByDate !== highest ? ' ← 两者不同，取版本更高者' : ''}`,
);
console.log(highest);
