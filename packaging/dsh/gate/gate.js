#!/usr/bin/env node
/**
 * DSH fnOS 入口反向代理（gate）
 *
 * 为什么需要它：
 *   `dsh web` 的浏览器认证是「一次性启动令牌 → 持久 cookie」：进程启动时打印
 *   `http://<host>:<port>/?token=<token>`，浏览器访问这个带令牌的地址才会拿到
 *   `Set-Cookie: dsh-auth-…`。而飞牛桌面入口的 URL 是写死的，没法带动态令牌。
 *
 * 本进程因此承担两件事，**浏览器地址栏始终停在 3080**：
 *   1. 首次进入（没有会话 cookie）时，用启动令牌在服务端换一次 cookie，
 *      再 303 回同一个地址 —— 浏览器不跳端口。
 *   2. 之后把所有请求（含 WebSocket）反向代理到 dsh 的 3081。
 *
 * 为什么必须改写 Host / Origin：
 *   dsh 的会话 cookie 与 `/api` 的 Host/Origin 围栏都绑定「请求 authority」。
 *   浏览器看到的是 3080，dsh 认为自己在 3081，所以代理时统一把 Host 改成
 *   `<WEB_HOST>:<WEB_PORT>`、Origin 改成对应的 http 源，否则一律 401/403。
 *
 * 环境变量：
 *   DSH_GATE_HOST         监听地址（NAS 局域网 IP）
 *   DSH_GATE_PORT         监听端口（= manifest 的 service_port，飞牛桌面入口用）
 *   DSH_GATE_EXTRA_HOSTS  额外监听地址，逗号分隔（默认 127.0.0.1，供 NAS 本机访问）
 *   DSH_WEB_HOST          dsh 的监听地址
 *   DSH_WEB_PORT          dsh 的监听端口
 *   DSH_TOKEN_FILE        启动令牌文件（cmd/main 写入）
 */
'use strict';

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');

const GATE_HOST = process.env.DSH_GATE_HOST || '127.0.0.1';
const GATE_PORT = Number(process.env.DSH_GATE_PORT || 3080);
const WEB_HOST = process.env.DSH_WEB_HOST || GATE_HOST;
const WEB_PORT = Number(process.env.DSH_WEB_PORT || 3081);
const TOKEN_FILE = process.env.DSH_TOKEN_FILE || '';

// dsh 本体只绑局域网 IP，127.0.0.1 上没人监听；额外监听这些地址，
// 让「在 NAS 本机上开浏览器」也能进（用 127.0.0.1:3080，不要用 localhost）。
const EXTRA_HOSTS = (process.env.DSH_GATE_EXTRA_HOSTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((h) => h && h !== GATE_HOST);

// dsh 认为自己的 authority；代理时所有请求都按这个身份转发
const UPSTREAM_AUTHORITY = `${WEB_HOST}:${WEB_PORT}`;
const UPSTREAM_ORIGIN = `http://${UPSTREAM_AUTHORITY}`;

const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);

function log(message) {
    process.stdout.write(`[gate] ${message}\n`);
}

/** 读当前启动令牌；cmd/main 尚未写入时返回空串。 */
function readToken() {
    if (!TOKEN_FILE) return '';
    try {
        return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    } catch {
        return '';
    }
}

/** 浏览器是否已经持有 dsh 的会话 cookie（名字由 dsh 按 authority 生成）。 */
function hasSessionCookie(req) {
    const raw = req.headers.cookie;
    if (!raw) return false;
    return raw.split(';').some((segment) => segment.trim().startsWith('dsh-auth-'));
}

/** 浏览器发起的顶层文档请求（导航），只有这种请求值得自动换 cookie。 */
function isDocumentRequest(req) {
    return req.method === 'GET' && String(req.headers.accept || '').includes('text/html');
}

function respond(res, statusCode, body, extraHeaders) {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    res.writeHead(statusCode, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        ...extraHeaders,
    });
    res.end(body);
}

/** 探测 dsh 本体是否还在监听：崩掉时不要代理到一个没人监听的端口。 */
function webAlive() {
    return new Promise((resolve) => {
        const socket = net.connect({ host: WEB_HOST, port: WEB_PORT });
        const settle = (ok) => {
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(1500, () => settle(false));
        socket.once('connect', () => settle(true));
        socket.once('error', () => settle(false));
    });
}

/**
 * 用启动令牌在服务端换一次会话 cookie，然后把浏览器 303 回原地址。
 * 地址栏因此始终停在 3080，不会跳到 3081。
 */
function mintSession(req, res) {
    const token = readToken();
    if (token.length === 0) {
        respond(res, 503, 'DSH 正在启动，请稍候刷新…\n');
        return;
    }
    const back = String(req.url || '/').split('?')[0] || '/';
    const upstream = http.request(
        {
            host: WEB_HOST,
            port: WEB_PORT,
            method: 'GET',
            path: `/?token=${encodeURIComponent(token)}`,
            headers: { host: UPSTREAM_AUTHORITY },
        },
        (upstreamRes) => {
            upstreamRes.resume();
            const cookies = upstreamRes.headers['set-cookie'];
            if (!cookies || upstreamRes.statusCode >= 400) {
                log(`WARN: 启动令牌兑换失败（dsh 返回 ${upstreamRes.statusCode}），重启应用可刷新令牌`);
                respond(res, 503, 'DSH 正在重启，请稍候刷新…\n');
                return;
            }
            respond(res, 303, '', { location: back, 'set-cookie': cookies });
        },
    );
    upstream.setTimeout(5000, () => upstream.destroy());
    upstream.on('error', (error) => {
        log(`WARN: 连接 dsh 失败: ${error.message}`);
        respond(res, 503, 'DSH 正在重启，请稍候刷新…\n');
    });
    upstream.end();
}

/** 把上游返回的绝对地址改回浏览器看到的那一个。 */
function rewriteLocation(location, browserHost) {
    if (typeof location !== 'string') return location;
    if (!location.startsWith(UPSTREAM_ORIGIN)) return location;
    return `http://${browserHost}${location.slice(UPSTREAM_ORIGIN.length)}`;
}

/** 以 dsh 的身份构造转发请求头。 */
function upstreamHeaders(req) {
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
        if (HOP_BY_HOP.has(name)) continue;
        headers[name] = value;
    }
    headers.host = UPSTREAM_AUTHORITY;
    if (headers.origin !== undefined) headers.origin = UPSTREAM_ORIGIN;
    if (headers.referer !== undefined) {
        try {
            const ref = new URL(String(headers.referer));
            headers.referer = `${UPSTREAM_ORIGIN}${ref.pathname}${ref.search}`;
        } catch {
            delete headers.referer;
        }
    }
    return headers;
}

/** 反向代理一个普通 HTTP 请求（含流式响应）。 */
function proxyRequest(req, res) {
    const upstream = http.request(
        {
            host: WEB_HOST,
            port: WEB_PORT,
            method: req.method,
            path: req.url,
            headers: upstreamHeaders(req),
        },
        (upstreamRes) => {
            // cookie 过期/签名变了：重新换一次，而不是把 401 甩给用户
            if (upstreamRes.statusCode === 401 && isDocumentRequest(req) && hasSessionCookie(req)) {
                upstreamRes.resume();
                mintSession(req, res);
                return;
            }
            const headers = { ...upstreamRes.headers };
            if (headers.location !== undefined) {
                headers.location = rewriteLocation(headers.location, req.headers.host || '');
            }
            res.writeHead(upstreamRes.statusCode || 502, headers);
            upstreamRes.pipe(res);
        },
    );
    upstream.on('error', () => respond(res, 503, 'DSH 正在重启，请稍候刷新…\n'));
    req.pipe(upstream);
}

/** 反向代理 WebSocket：改写握手头后双向裸转发。 */
function proxyUpgrade(req, socket, head) {
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) headers[name] = value;
    headers.host = UPSTREAM_AUTHORITY;
    if (headers.origin !== undefined) headers.origin = UPSTREAM_ORIGIN;

    const upstream = net.connect(WEB_PORT, WEB_HOST, () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (const [name, value] of Object.entries(headers)) {
            if (Array.isArray(value)) {
                for (const one of value) lines.push(`${name}: ${one}`);
            } else {
                lines.push(`${name}: ${value}`);
            }
        }
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head && head.length > 0) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
    });
    upstream.setNoDelay(true);
    socket.setNoDelay(true);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
}

async function handleRequest(req, res) {
    if (req.url === '/healthz') {
        const up = readToken().length > 0 && (await webAlive());
        respond(res, up ? 200 : 503, up ? 'ready\n' : 'starting\n');
        return;
    }

    // 首次导航：没有会话 cookie 就先换 cookie，地址栏保持不变
    if (isDocumentRequest(req) && !hasSessionCookie(req)) {
        mintSession(req, res);
        return;
    }

    proxyRequest(req, res);
}

const servers = [];
for (const host of [GATE_HOST, ...EXTRA_HOSTS]) {
    const primary = host === GATE_HOST;
    const server = http.createServer((req, res) => {
        handleRequest(req, res).catch(() => respond(res, 500, 'gate 内部错误\n'));
    });
    server.on('upgrade', (req, socket, head) => proxyUpgrade(req, socket, head));
    server.on('error', (error) => {
        if (primary) {
            log(`FATAL: 端口 ${host}:${GATE_PORT} 监听失败: ${error.message}`);
            process.exit(1);
        }
        // 附加地址（例如 127.0.0.1）监听失败不影响主入口
        log(`WARN: 附加地址 ${host}:${GATE_PORT} 监听失败: ${error.message}`);
    });
    server.listen(GATE_PORT, host, () => {
        log(`入口就绪 http://${host}:${GATE_PORT} → 反向代理 ${UPSTREAM_ORIGIN}`);
    });
    servers.push(server);
}

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        for (const server of servers) server.close();
        setTimeout(() => process.exit(0), 2000).unref();
    });
}
