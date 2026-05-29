'use strict';
// tunnel-agent.js — 通过 HTTP CONNECT 代理建立 TLS 隧道的 https.Agent。
// 用于让出站请求经过本地全局代理（如 clash 的 127.0.0.1:7890）。

const http  = require('http');
const https = require('https');
const tls   = require('tls');
const { URL } = require('url');

class TunnelAgent extends https.Agent {
    constructor(proxyUrl, agentOptions = {}) {
        super(Object.assign({ keepAlive: false }, agentOptions));
        this.proxy = new URL(proxyUrl);
    }

    createConnection(options, callback) {
        const targetHost = options.host;
        const targetPort = options.port || 443;

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

        connectReq.once('connect', (res, socket) => {
            if (res.statusCode !== 200) {
                socket.destroy();
                callback(new Error(`代理 CONNECT 隧道建立失败: ${res.statusCode} ${res.statusMessage || ''}`.trim()));
                return;
            }
            const tlsSocket = tls.connect({
                socket,
                servername:         options.servername || targetHost,
                rejectUnauthorized: options.rejectUnauthorized !== false,
            });
            tlsSocket.once('secureConnect', () => callback(null, tlsSocket));
            tlsSocket.once('error', callback);
        });
        connectReq.once('error', callback);
        connectReq.end();
    }
}

module.exports = { TunnelAgent };
