/**
 * DSH —— 飞牛 fnOS 运行器
 *
 * 架构（单入口反向代理，浏览器只看到一个源）：
 *
 *   浏览器 ──► 0.0.0.0:SERVICE_PORT（本运行器，HTTP + WebSocket 反向代理）
 *                        │
 *                        └──► 127.0.0.1:DSH_PORT（dsh web 本体，仅回环）
 *
 * 为什么代理而不是让 dsh 直接对外：
 *   dsh 的 /api 有一道 browser-trust 围栏（dsh-client-connection 的
 *   isTrustedApiRequest）：Host 必须是回环、绑定地址或 --trusted-host 里的
 *   authority，且请求若带 Origin，必须与 Host 同源，否则一律 403。
 *   fnOS 里浏览器地址是 http://NAS:3080，而 dsh 若自己对外就得是另一个端口
 *   或另一个 authority，于是「页面在 3080、接口在 3081」的跨源请求会被围栏
 *   拒绝（表现为插件安装/卸载报 origin not trusted）。
 *   由运行器统一代理后，浏览器所有请求都是同源 3080，且转发时剥掉
 *   Origin / Referer、Host 改写为回环 —— 围栏按「回环 Host、无 Origin」放行。
 *
 * 认证：
 *   dsh 的浏览器会话 cookie 由 <DSH_HOME>/.credentials.yaml 里
 *   client-connection/browser-session 的 secret 用 HMAC-SHA256 签发：
 *     cookie 名 = "dsh-auth-" + base64url(sha256(authority))
 *     cookie 值 = "v1." + base64url(payload) + "." + base64url(HMAC(secret, payload))
 *   运行器确保该 secret 存在，并在每个转发请求上自签一个有效 cookie，
 *   浏览器无需处理启动令牌，也不会收到 dsh 的 Set-Cookie。
 *   若上游改了 cookie 格式（自签失效），回退到官方「启动令牌换 cookie」。
 *
 * 环境变量（由 appshell/cmd/main 注入）：
 *   TRIM_APPDEST / TRIM_PKGVAR / TRIM_SERVICE_PORT / TRIM_DATA_SHARE_PATHS
 *   DSH_NODE_BIN    Node 运行时（应用中心 nodejs_v24）
 *   DSH_PORT        dsh 本体端口（= SERVICE_PORT + 1）
 *   DSH_PATCH_FILE  --patch 叠加层（可选）
 *   DSH_PUBLIC_URL  对外地址（可选，写进 dsh 打印的链接与 DSH_WEB_URL）
 *   DSH_HOME        配置目录（<数据目录>/.dsh）
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const APP_DIR = process.env.TRIM_APPDEST || path.resolve(__dirname, '..');
const PKGVAR = process.env.TRIM_PKGVAR || path.join(APP_DIR, 'var');
const SERVICE_PORT = Number.parseInt(process.env.TRIM_SERVICE_PORT || '3080', 10);
const DSH_PORT = Number.parseInt(process.env.DSH_PORT || String(SERVICE_PORT + 1), 10);
const NODE_BIN = process.env.DSH_NODE_BIN || process.execPath;
const DSH_BIN = path.join(APP_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const PATCH_FILE = process.env.DSH_PATCH_FILE || '';
const PUBLIC_URL = process.env.DSH_PUBLIC_URL || '';
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_AUTHORITY = `${UPSTREAM_HOST}:${DSH_PORT}`;
const DSH_HOME = process.env.DSH_HOME || path.join(PKGVAR, '.dsh');

// umask 0：dsh 在数据目录里创建的文件对 NAS 用户与 SMB 可读写
try { process.umask(0); } catch { /* ignore */ }

/**
 * 局域网 HTTP 属于非安全上下文，旧浏览器缺 crypto.randomUUID（上游已用
 * crypto.getRandomValues 兜底，这里只是再垫一层，无副作用）；ownsHost 让
 * 前端把当前页面当成「宿主自带入口」，回环限定的设置项不会降级。
 */
const INJECT =
    'if(typeof globalThis!=="undefined"){globalThis.__DSH_TRANSPORT__={...(globalThis.__DSH_TRANSPORT__||{}),ownsHost:true};}'
    + 'if(typeof crypto!=="undefined"&&!crypto.randomUUID){crypto.randomUUID=function(){return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(c){var r=Math.random()*16|0,v=c==="x"?r:(Math.random()*0x3|0x8);return v.toString(16);});};}';

function log(message) {
    process.stdout.write(`[runner] ${message}\n`);
}

// ---------- 认证 cookie ----------

function encodeBase64Url(value) {
    return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value) {
    const padding = '='.repeat((4 - (value.length % 4)) % 4);
    return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64');
}

/** 确保 .credentials.yaml 里有 browser-session secret，返回其 Buffer 形式。 */
function ensureSessionSecret() {
    const credPath = path.join(DSH_HOME, '.credentials.yaml');
    const block = (secret) =>
        `  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: ${secret}\n`;
    try {
        if (fs.existsSync(credPath)) {
            const content = fs.readFileSync(credPath, 'utf8');
            const matched = content.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/);
            if (matched) return decodeBase64Url(matched[1]);
        }
        const secret = encodeBase64Url(crypto.randomBytes(32));
        fs.mkdirSync(DSH_HOME, { recursive: true, mode: 0o700 });
        if (!fs.existsSync(credPath)) {
            fs.writeFileSync(credPath, `version: 1\nrecords:\n${block(secret)}`, { mode: 0o600 });
        } else {
            const content = fs.readFileSync(credPath, 'utf8');
            const next = /^records:\s*$/m.test(content)
                ? content.replace(/^records:\s*$/m, `records:\n${block(secret).trimEnd()}`)
                : `${content}\n${block(secret)}`;
            fs.writeFileSync(credPath, next, { mode: 0o600 });
        }
        log('已预置 browser-session 认证密钥');
        return decodeBase64Url(secret);
    } catch (error) {
        log(`WARN: 预置认证密钥失败: ${error.message}`);
        return null;
    }
}

let secretCache = null;
let signedCookie = null;
let signedAt = 0;

/** 自签 dsh 的会话 cookie（缓存 12 小时）。 */
function forgeCookie() {
    const now = Date.now();
    if (signedCookie !== null && now - signedAt < 12 * 3600 * 1000) return signedCookie;
    if (secretCache === null) secretCache = ensureSessionSecret();
    if (secretCache === null) return '';
    const name = `dsh-auth-${encodeBase64Url(crypto.createHash('sha256').update(UPSTREAM_AUTHORITY).digest())}`;
    const payload = {
        version: 1,
        authority: UPSTREAM_AUTHORITY,
        issuedAt: now,
        expiresAt: now + 30 * 24 * 3600 * 1000,
    };
    const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
    const signature = encodeBase64Url(crypto.createHmac('sha256', secretCache).update(body).digest());
    signedCookie = `${name}=v1.${body}.${signature}`;
    signedAt = now;
    return signedCookie;
}

// 官方启动令牌（自签失效时的回退）：dsh 启动时会打印 ?token=...，兑换一次拿真 cookie
let launchToken = '';
let officialCookie = '';

function authCookie() {
    return officialCookie || forgeCookie();
}

// ---------- 反向代理 ----------

const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/**
 * 丢掉浏览器带来的 dsh 会话 cookie。
 *
 * dsh 的 cookieValue() 只取「同名 cookie 的第一个」，而运行器签发的那份是追加在
 * 后面的。浏览器里若残留一份旧的 dsh-auth-*（以前直连 3081、或上一版转发过
 * Set-Cookie 时留下的），它就会遮蔽运行器签发的新 cookie，dsh 一律 401，
 * 页面只剩一句「dsh web authentication required」。
 */
function stripSessionCookies(cookieHeader) {
    return cookieHeader
        .split(';')
        .map((segment) => segment.trim())
        .filter((segment) => segment !== '' && !segment.startsWith('dsh-auth-'))
        .join('; ');
}

function upstreamHeaders(req, injectCookie) {
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
        if (HOP_BY_HOP.has(name)) continue;
        // dsh 的围栏要求 Origin 与 Host 同源；浏览器看到的是代理地址，
        // 与回环 Host 不同源，因此直接剥掉（围栏对「无 Origin」放行）。
        if (name === 'origin' || name === 'referer') continue;
        if (name === 'cookie') continue;
        headers[name] = value;
    }
    headers.host = UPSTREAM_AUTHORITY;
    const cookie = injectCookie ? authCookie() : '';
    const incoming = stripSessionCookies(req.headers.cookie || '');
    if (cookie) headers.cookie = incoming ? `${incoming}; ${cookie}` : cookie;
    else if (incoming) headers.cookie = incoming;
    if (String(req.headers.accept || '').includes('text/html')) delete headers['accept-encoding'];
    return headers;
}

function injectHtml(html) {
    const tag = `<script>${INJECT}</script>`;
    if (html.includes('<head>')) return html.replace('<head>', `<head>${tag}`);
    if (html.includes('<body>')) return html.replace('<body>', `<body>${tag}`);
    if (html.includes('</body>')) return html.replace('</body>', `${tag}</body>`);
    return html + tag;
}

/** 用官方启动令牌换一次真 cookie（自签失效时的兜底）。 */
function mintOfficialCookie(req) {
    return new Promise((resolve) => {
        if (launchToken === '') return resolve(false);
        const upstream = http.request(
            { host: UPSTREAM_HOST, port: DSH_PORT, method: 'GET', path: `/?token=${encodeURIComponent(launchToken)}`, headers: { host: UPSTREAM_AUTHORITY } },
            (res) => {
                res.resume();
                const cookies = res.headers['set-cookie'];
                if (res.statusCode < 400 && cookies && cookies.length > 0) {
                    officialCookie = cookies.map((one) => one.split(';')[0]).join('; ');
                    log('自签 cookie 失效，已改用官方启动令牌签发的 cookie');
                    resolve(true);
                    return;
                }
                resolve(false);
            },
        );
        upstream.setTimeout(5000, () => upstream.destroy());
        upstream.on('error', () => resolve(false));
        upstream.end();
    });
}

function proxyRequest(req, res, retried) {
    const upstream = http.request(
        {
            host: UPSTREAM_HOST,
            port: DSH_PORT,
            method: req.method,
            path: req.url,
            headers: upstreamHeaders(req, true),
        },
        (upstreamRes) => {
            // 自签 cookie 被上游拒绝时回退官方令牌（GET 幂等，只重试一次）
            if (upstreamRes.statusCode === 401 && req.method === 'GET' && !retried) {
                upstreamRes.resume();
                mintOfficialCookie(req).then((ok) => {
                    if (ok) proxyRequest(req, res, true);
                    else sendError(res, 401, 'DSH 认证未通过，请重启应用\n');
                });
                return;
            }

            const headers = { ...upstreamRes.headers };
            // 认证由运行器负责，dsh 下发的 cookie 不必透传给浏览器
            delete headers['set-cookie'];

            const contentType = upstreamRes.headers['content-type'] || '';
            if (!contentType.includes('text/html')) {
                res.writeHead(upstreamRes.statusCode || 502, headers);
                upstreamRes.pipe(res);
                return;
            }

            const chunks = [];
            upstreamRes.on('data', (chunk) => chunks.push(chunk));
            upstreamRes.on('end', () => {
                const body = Buffer.from(injectHtml(Buffer.concat(chunks).toString('utf8')), 'utf8');
                headers['content-length'] = body.length;
                delete headers['content-encoding'];
                delete headers['transfer-encoding'];
                res.writeHead(upstreamRes.statusCode || 200, headers);
                res.end(body);
            });
        },
    );
    upstream.on('error', () => sendError(res, 502, 'DSH 尚未就绪，请稍后刷新重试\n'));
    req.pipe(upstream);
}

function sendError(res, status, message) {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(message);
}

/** WebSocket：裸透传握手，注入 cookie，剥掉 Origin/Referer。 */
function proxyUpgrade(req, socket, head) {
    const upstream = net.connect(DSH_PORT, UPSTREAM_HOST, () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (let index = 0; index < req.rawHeaders.length; index += 2) {
            const name = req.rawHeaders[index];
            const lower = name.toLowerCase();
            if (lower === 'host' || lower === 'cookie' || lower === 'origin' || lower === 'referer') continue;
            lines.push(`${name}: ${req.rawHeaders[index + 1]}`);
        }
        lines.push(`Host: ${UPSTREAM_AUTHORITY}`);
        const cookie = [stripSessionCookies(req.headers.cookie || ''), authCookie()].filter(Boolean).join('; ');
        if (cookie) lines.push(`Cookie: ${cookie}`);
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head && head.length > 0) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
    });
    const cleanup = () => {
        try { upstream.destroy(); } catch { /* ignore */ }
        try { socket.destroy(); } catch { /* ignore */ }
    };
    upstream.on('error', cleanup);
    socket.on('error', cleanup);
}

// ---------- 子进程 ----------

let child = null;
let stopping = false;
let restartTimer = null;

function startDsh() {
    // 顺序有讲究：--patch 是根级选项，必须紧跟子命令（`web --patch <file> …`）；
    // 放到其它子命令选项之后会被当成未知选项，dsh 直接退出（退出码 1）。
    const args = [DSH_BIN, 'web'];
    if (PATCH_FILE && fs.existsSync(PATCH_FILE)) args.push('--patch', PATCH_FILE);
    args.push('--port', String(DSH_PORT), '--no-open');
    if (PUBLIC_URL !== '') args.push('--public-url', PUBLIC_URL);

    const binDir = path.join(APP_DIR, 'node_modules', '.bin');
    const spawned = spawn(NODE_BIN, args, {
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
        cwd: process.env.HOME || PKGVAR,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    // dsh 把带启动令牌的地址打在 stdout；留下令牌作为认证回退
    const scan = (chunk) => {
        const text = chunk.toString();
        process.stdout.write(text);
        const matched = text.match(/token=([A-Za-z0-9_-]{16,})/);
        if (matched) launchToken = matched[1];
    };
    spawned.stdout.on('data', scan);
    spawned.stderr.on('data', (chunk) => process.stderr.write(chunk));

    spawned.on('exit', (code) => {
        if (stopping) return;
        log(`dsh web 已退出（${code}），3 秒后重启`);
        child = null;
        if (restartTimer === null) {
            restartTimer = setTimeout(() => {
                restartTimer = null;
                if (!stopping) {
                    child = startDsh();
                }
            }, 3000);
        }
    });
    return spawned;
}

function shutdown(signal) {
    stopping = true;
    log(`收到 ${signal}，正在退出`);
    if (restartTimer !== null) clearTimeout(restartTimer);
    if (server !== null) {
        try { server.close(); } catch { /* ignore */ }
    }
    if (child !== null && child.exitCode === null) {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    // 给子进程 3 秒收尾；超时由 cmd/main 兜底强杀
    setTimeout(() => process.exit(0), 3000).unref();
}

// ---------- 启动 ----------

let server = null;

async function main() {
    if (!fs.existsSync(DSH_BIN)) {
        log(`FATAL: 未找到 dsh 入口 ${DSH_BIN}`);
        process.exit(1);
    }
    ensureSessionSecret();
    fs.mkdirSync(PKGVAR, { recursive: true });

    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => shutdown(signal));

    child = startDsh();

    server = http.createServer((req, res) => {
        if (req.url === '/healthz') {
            sendError(res, 200, 'ready\n');
            return;
        }
        proxyRequest(req, res, false);
    });
    server.on('upgrade', (req, socket, head) => proxyUpgrade(req, socket, head));
    server.on('error', (error) => {
        log(`FATAL: 端口 ${SERVICE_PORT} 监听失败: ${error.message}`);
        if (child !== null) child.kill('SIGTERM');
        process.exit(1);
    });
    server.listen(SERVICE_PORT, '0.0.0.0', () => {
        log(`入口就绪 0.0.0.0:${SERVICE_PORT} → ${UPSTREAM_AUTHORITY}`);
    });
}

main();
