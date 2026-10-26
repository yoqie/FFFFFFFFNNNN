#!/usr/bin/env node
/**
 * 把 npm 上的 dsh-plugin-catalog 目录镜像成单文件 index.json。
 *
 * DSH 插件市场的索引源是一个 https 上的 JSON 地址；官方默认放在 jsDelivr
 * （cdn.jsdelivr.net），国内网络对该域名的 TLS 握手经常被切断。本脚本从 npm
 * 官方 registry 取包（权威来源），解出包内 index.json 并校验后写出，
 * 由 .github/workflows/plugin-catalog-sync.yml 提交到 plugin-catalog 数据分支。
 *
 * 用法：node scripts/mirror-plugin-catalog.mjs [输出路径，默认 out/index.json]
 * 输出：stdout 打印 `version=<上游版本>` 与 `sha=<内容 sha256>`；
 *       若设置了 GITHUB_OUTPUT，同时追加到该文件供 workflow 读取。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const PKG = 'dsh-plugin-catalog'
const REGISTRY = (process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/u, '')
const OUTPUT = resolve(process.argv[2] ?? 'out/index.json')

/** 带重试的 GET，返回 Buffer。 */
async function get(url, attempt = 1) {
    try {
        const res = await fetch(url, { headers: { accept: 'application/json, application/octet-stream' } })
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
        return Buffer.from(await res.arrayBuffer())
    } catch (error) {
        if (attempt >= 3) throw error
        await new Promise((r) => setTimeout(r, 2000 * attempt))
        return get(url, attempt + 1)
    }
}

/** 从 tarball 里解出 package/index.json（用系统 tar，GitHub runner 与本机都有）。 */
function extractIndex(tarball) {
    const work = mkdtempSync(join(tmpdir(), 'dsh-catalog-'))
    try {
        const tgz = join(work, 'catalog.tgz')
        writeFileSync(tgz, tarball)
        mkdirSync(join(work, 'x'))
        execFileSync('tar', ['-xzf', tgz, '-C', join(work, 'x')], { stdio: 'inherit' })
        return readFileSync(join(work, 'x', 'package', 'index.json'), 'utf8')
    } finally {
        rmSync(work, { recursive: true, force: true })
    }
}

const meta = JSON.parse((await get(`${REGISTRY}/${PKG}`)).toString('utf8'))
const version = meta['dist-tags']?.latest
if (typeof version !== 'string') throw new Error(`no latest dist-tag for ${PKG}`)
const tarballUrl = meta.versions?.[version]?.dist?.tarball
if (typeof tarballUrl !== 'string') throw new Error(`no tarball for ${PKG}@${version}`)

const raw = extractIndex(await get(tarballUrl))
const index = JSON.parse(raw)
if (index.format !== 1) throw new Error(`unexpected catalog format: ${String(index.format)}`)
if (!Array.isArray(index.plugins) || index.plugins.length === 0) throw new Error('catalog has no plugins')

mkdirSync(dirname(OUTPUT), { recursive: true })
writeFileSync(OUTPUT, raw)

const sha = createHash('sha256').update(raw).digest('hex')
const lines = [`version=${version}`, `sha=${sha}`, `plugins=${index.plugins.length}`]
for (const line of lines) console.log(line)
if (process.env.GITHUB_OUTPUT !== undefined) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
