#!/usr/bin/env node
/**
 * DSH fnOS 入口跳转器（gate）
 *
 * 为什么需要它：
 *   `dsh web` 的浏览器认证是「一次性启动令牌 → 持久 cookie」：进程启动时打印
 *   `http://<host>:<port>/?token=<token>`，浏览器访问这个带令牌的地址会拿到
 *   `Set-Cookie: dsh-auth-…`（HttpOnly、SameSite=Strict），此后正常访问即可。
 *   令牌每次启动都会变，没法写死进飞牛桌面入口的 URL，所以需要一个固定地址：
 *   它读到当前令牌，把浏览器 302 到带令牌的地址，剩下的全部交给 dsh 自己。
 *
 * 它**不做**任何代理、不改写请求头、不签发 cookie——只是把浏览器送到官方入口。
 * 跳转之后所有流量（含 WebSocket）都直连 dsh，与本进程无关。
 *
 * 环境变量：
 *   DSH_GATE_HOST   监听地址（NAS 的局域网 IP）
 *   DSH_GATE_PORT   监听端口（= manifest 的 service_port，飞牛桌面入口用）
 *   DSH_WEB_HOST    dsh 的监听地址（同一个 IP）
 *   DSH_WEB_PORT    dsh 的监听端口
 *   DSH_TOKEN_FILE  启动令牌文件（cmd/main 写入）
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');

const GATE_HOST = process.env.DSH_GATE_HOST || '127.0.0.1';
const GATE_PORT = Number(process.env.DSH_GATE_PORT || 3080);
const WEB_HOST = process.env.DSH_WEB_HOST || GATE_HOST;
const WEB_PORT = Number(process.env.DSH_WEB_PORT || 3081);
const TOKEN_FILE = process.env.DSH_TOKEN_FILE || '';

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

const server = http.createServer((req, res) => {
    // 健康检查：给 cmd/main 与排查用，不参与跳转
    if (req.url === '/healthz') {
        const token = readToken();
        res.writeHead(token ? 200 : 503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(token ? 'ready\n' : 'starting\n');
        return;
    }

    const token = readToken();
    if (token.length === 0) {
        // dsh 还在启动：明确告知，而不是给浏览器一个 401
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('DSH 正在启动，请稍候刷新…\n');
        return;
    }

    // 令牌只走一次跳转：带上后 dsh 会下发 cookie，之后用户直接访问 dsh 端口即可
    const target = `http://${WEB_HOST}:${WEB_PORT}/?token=${encodeURIComponent(token)}`;
    res.writeHead(302, { location: target, 'cache-control': 'no-store' });
    res.end();
});

server.on('error', (error) => {
    log(`FATAL: 端口 ${GATE_HOST}:${GATE_PORT} 监听失败: ${error.message}`);
    process.exit(1);
});

server.listen(GATE_PORT, GATE_HOST, () => {
    log(`入口就绪 http://${GATE_HOST}:${GATE_PORT} → http://${WEB_HOST}:${WEB_PORT}/?token=…`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
    });
}
