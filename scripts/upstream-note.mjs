#!/usr/bin/env node
/*
 * upstream-note.mjs — 取上游项目某个版本的 Release 正文（即上游自己的更新说明）。
 *
 * 用途：让索引里的 release_note / changelog 以及本源 Release 的说明，
 *       直接跟随上游发布的更新内容，而不是只写一句「更新内容见上游」。
 *
 * 作为模块：import { fetchUpstreamNote, sanitizeNote } from './upstream-note.mjs'
 * 作为命令：node scripts/upstream-note.mjs --repo owner/name --version 1.2.3 \
 *             [--tags "v{v},{v}"] [--strip-urls] [--max-len 6000]
 *           成功时把正文打到 stdout；取不到时输出空字符串、退出码 0（不阻断流程）。
 *
 * 设计要点：
 * - 任何网络/解析失败都退化为空字符串，调用方据此回退到默认文案，绝不让同步链失败。
 * - --strip-urls：去掉正文里的链接地址（保留链接文字）。用于不希望暴露上游地址的应用。
 */

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const HEADERS = { 'User-Agent': 'upstream-note', Accept: 'application/vnd.github+json' };
if (TOKEN) HEADERS.Authorization = `Bearer ${TOKEN}`;

/** 去掉正文里的 URL：markdown 链接保留文字，裸链接整段删除，顺带清理空行。 */
export function sanitizeNote(text) {
  if (!text) return '';
  let s = String(text);
  // [文字](https://...) -> 文字
  s = s.replace(/\[([^\]]*)\]\((?:https?:\/\/|mailto:)[^)]*\)/g, '$1');
  // <https://...> -> 删除
  s = s.replace(/<(?:https?:\/\/|mailto:)[^>]*>/g, '');
  // 裸链接 -> 删除
  s = s.replace(/(?:https?:\/\/|www\.)[^\s)\]>]+/g, '');
  // 清理因删除产生的大量空白与空行
  s = s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

/**
 * 取上游某版本的 Release 正文。
 * @param {string} repo      上游仓库，如 deepseek-ai/deepseek-harness
 * @param {string} version   版本号，如 0.2.1-rc.2
 * @param {object} [opt]
 * @param {string[]} [opt.tags]  候选 tag 模板，`{v}` 会被替换为版本号
 * @param {boolean} [opt.stripUrls] 是否去掉链接地址
 * @param {number}  [opt.maxLen]    截断长度，0/缺省表示不截断
 * @returns {Promise<string>}
 */
export async function fetchUpstreamNote(repo, version, opt = {}) {
  const {
    tags = ['v{v}', '{v}', '{repo}-v{v}'],
    stripUrls = false,
    maxLen = 0,
  } = opt;
  if (!repo || !version) return '';
  const candidates = tags.map((t) =>
    t.replace('{v}', version).replace('{repo}', String(repo).split('/').pop()));

  let releases = [];
  try {
    // 优先直接按 tag 取，命中即返回，省一次全量列表请求
    for (const tag of candidates) {
      try {
        const r = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers: HEADERS });
        if (r.ok) {
          const j = await r.json();
          if (j && (j.body || '').trim()) return finish(j.body);
        }
      } catch { /* 换下一个候选 tag */ }
    }
    const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, { headers: HEADERS });
    if (!r.ok) return '';
    releases = await r.json();
    if (!Array.isArray(releases)) return '';
  } catch (e) {
    console.warn(`upstream-note: 取 ${repo} 的 Release 失败，忽略（${e.message}）`);
    return '';
  }

  // 兜底：从列表里按 tag 结尾或版本号匹配
  const norm = candidates.map((c) => c.toLowerCase());
  for (const rel of releases) {
    if (rel.draft) continue;
    const tag = String(rel.tag_name || '').toLowerCase();
    if (!norm.includes(tag)) continue;
    const body = (rel.body || '').trim();
    if (body) return finish(body);
  }
  return '';

  function finish(body) {
    let s = stripUrls ? sanitizeNote(body) : String(body).trim();
    if (maxLen > 0 && s.length > maxLen) {
      s = `${s.slice(0, maxLen).trimEnd()}\n\n…（更新说明较长，已截断）`;
    }
    return s;
  }
}

// ---------------------------------------------------------------- CLI
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (k, d = '') => {
    const i = argv.indexOf(k);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  const repo = arg('--repo');
  const version = arg('--version');
  const tags = arg('--tags') ? arg('--tags').split(',') : undefined;
  const stripUrls = argv.includes('--strip-urls');
  const maxLen = Number(arg('--max-len', '0')) || 0;
  const note = await fetchUpstreamNote(repo, version, { tags, stripUrls, maxLen });
  process.stdout.write(note);
}
