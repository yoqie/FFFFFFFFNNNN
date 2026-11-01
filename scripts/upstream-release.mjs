#!/usr/bin/env node
// 解析上游要跟随的版本。
//
// 两条口径，用 --order 选：
//   time（默认，跟紧官方）  取**发布时间最新**的 Release —— 也就是官方"当前在推的那条线"。
//                           官方会把老线补丁作为下一次发布推出来（例如 0.2.1-rc.5 比
//                           0.2.2-alpha.2 晚发布，npm 的 latest/next 都指向 rc.5）。
//   semver                 取**数字段最高**的 Release —— 只在"绝不能让版本号倒退"时用。
//
// 为什么版本号倒退曾经是事故：飞牛应用中心只比数字段（0.2.1-rc.5 → 0.2.1.5，
// 0.2.2-alpha.2 → 0.2.2.2），源里出现更小的号就判定"没有更新"，用户既收不到
// 更新提示也看不到更新内容。
//
// 现在的做法是：跟随口径用 time，**版本号单调**交给 scripts/next-version.mjs 保证
// （上游数字段低于历史高水位时，它会顺着高水位末段 +1），两者互不干扰。
//
// 用法：
//   node scripts/upstream-release.mjs --repo deepseek-ai/deepseek-harness --prefix dsh-v
//   node scripts/upstream-release.mjs --order semver
// 输出（stdout）：上游版本（去掉前缀）；细节打到 stderr。
// 取不到任何 Release 时输出空行并以 1 退出，交由调用方决定回退策略。

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const repo = arg('repo', 'deepseek-ai/deepseek-harness');
const prefix = arg('prefix', 'dsh-v');
const order = arg('order', 'time');
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

if (!['time', 'semver'].includes(order)) {
  console.error(`--order 只支持 time / semver，收到: ${order}`);
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
const list = all.filter((r) => r && !r.draft && String(r.tag_name || '').startsWith(prefix));
const versions = list.map((r) => String(r.tag_name).slice(prefix.length));

if (versions.length === 0) {
  console.error(`上游 ${repo} 没有以 ${prefix} 开头的非草稿 Release`);
  console.log('');
  process.exit(1);
}
// 接口本身按 published_at 倒序返回，第一个就是"发布得最新"的
const newestByDate = versions[0];
const highest = versions.reduce((a, b) => (cmp(b, a) > 0 ? b : a), '');

const chosen = order === 'time' ? newestByDate : highest;
console.error(
  `上游 Release ${versions.length} 个（按 --order ${order} 取值）：` +
    `按发布时间最新 ${newestByDate}；按版本最高 ${highest}（数字段 ${nums(highest).join('.')}）` +
    `${newestByDate !== highest ? ` ← 两者不同，取 ${chosen}` : ''}`,
);
console.log(chosen);
