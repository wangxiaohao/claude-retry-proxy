'use strict';
// tunnel-agent.js — 通过 HTTP CONNECT 代理建立 TLS 隧道的 https.Agent。
// 用于让出站请求经过本地全局代理（如 clash 的 127.0.0.1:7890）。

const http  = require('http');
const https = require('https');
const tls   = require('tls');
const { URL } = require('url');

class TunnelAgent extends https.Agent {
    constructor(proxyUrl, agentOptions = {}) {
        const { establishTimeoutMs = 0, ...rest } = agentOptions;
        super(Object.assign({ keepAlive: false }, rest));
        this.proxy = new URL(proxyUrl);
        this.establishTimeoutMs = establishTimeoutMs;
    }

    createConnection(options, callback) {
        const targetHost = options.host;
        const targetPort = options.port || 443;

        // 建连阶段（CONNECT 隧道 + TLS 握手）单独限时：正常 ~1s 内完成，
        // 出站代理节点瞬断时会无限卡在这里，快速失败把机会交给上层重试。
        let timer   = null;
        let settled = false;
        let pending = null; // 当前阶段持有的连接资源，超时时销毁
        const done = (err, socket) => {
            if (settled) { if (socket) socket.destroy(); return; }
            settled = true;
            clearTimeout(timer);
            callback(err, socket);
        };
        if (this.establishTimeoutMs > 0) {
            timer = setTimeout(() => {
                done(new Error(`tunnel establish timeout (${this.establishTimeoutMs}ms)`));
                if (pending) pending.destroy();
            }, this.establishTimeoutMs);
        }

        const connectReq = http.request({
            host:    this.proxy.hostname,
            port:    this.proxy.port || 80,
            method:  'CONNECT',
            path:    `${targetHost}:${targetPort}`,
            headers: { Host: `${targetHost}:${targetPort}` },
            // 若代理需要认证，可在 proxyUrl 写 user:pass@host:port
            ...(this.proxy.username
                ? { headers: {
                        Host: `${targetHost}:${targetPort}`,
                        'Proxy-Authorization': 'Basic ' + Buffer.from(
                            `${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`
                        ).toString('base64'),
                    } }
                : {}),
        });
        pending = connectReq;

        connectReq.once('connect', (res, socket) => {
            if (settled) { socket.destroy(); return; }
            if (res.statusCode !== 200) {
                socket.destroy();
                done(new Error(`代理 CONNECT 隧道建立失败: ${res.statusCode} ${res.statusMessage || ''}`.trim()));
                return;
            }
            const tlsSocket = tls.connect({
                socket,
                servername:         options.servername || targetHost,
                rejectUnauthorized: options.rejectUnauthorized !== false,
            });
            pending = tlsSocket;
            tlsSocket.once('secureConnect', () => done(null, tlsSocket));
            tlsSocket.once('error', done);
        });
        // CONNECT 被拒（非 2xx）时 Node 走 'response' 事件而非 'connect'，须显式处理否则挂死。
        connectReq.once('response', (res) => {
            done(new Error(`代理 CONNECT 隧道建立失败: ${res.statusCode} ${res.statusMessage || ''}`.trim()));
            connectReq.destroy();
        });
        connectReq.once('error', done);
        connectReq.end();
    }
}

module.exports = { TunnelAgent };
