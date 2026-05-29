'use strict';
// upstream.js — 构造向上游发起单次请求的函数，封装 http/https 与隧道代理细节。

const http  = require('http');
const https = require('https');
const { TunnelAgent } = require('./tunnel-agent');

// 逐跳头部，不应转发给上游。
const HOP_BY_HOP = new Set([
    'connection', 'proxy-connection', 'keep-alive', 'transfer-encoding',
    'te', 'trailer', 'upgrade',
]);

function sanitizeHeaders(headers, targetHost) {
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        if (HOP_BY_HOP.has(k.toLowerCase())) continue;
        out[k] = v;
    }
    out.host = targetHost; // 重写 Host，使 SNI/路由指向真实上游
    return out;
}

// 依据配置创建一个 agent（隧道代理 or 直连）。复用以保持连接池行为一致。
function createAgent(config) {
    const isHttps = config.targetProtocol === 'https';
    if (config.upstreamProxy && isHttps) {
        return new TunnelAgent(config.upstreamProxy);
    }
    if (isHttps) {
        return new https.Agent({ keepAlive: false });
    }
    return new http.Agent({ keepAlive: false });
}

// 返回 doAttempt(): Promise<IncomingMessage>，每次调用发起一次完整请求。
// method/path/headers 取自客户端请求；body 为已缓存的 Buffer。
function createRequester(config, agent) {
    const isHttps = config.targetProtocol === 'https';
    const transport = isHttps ? https : http;

    return function doAttempt(method, path, headers, body) {
        return new Promise((resolve, reject) => {
            const outHeaders = sanitizeHeaders(headers, config.targetHost);
            if (body && body.length) {
                outHeaders['content-length'] = String(body.length);
            } else {
                delete outHeaders['content-length'];
            }

            const req = transport.request(
                {
                    hostname: config.targetHost,
                    port:     config.targetPort,
                    path,
                    method,
                    headers:  outHeaders,
                    agent,
                },
                resolve
            );
            req.once('error', reject);
            if (body && body.length) req.write(body);
            req.end();
        });
    };
}

// 丢弃一个 IncomingMessage 的响应体（重试前调用，避免 socket 泄漏）。
function drainResponse(res) {
    return new Promise(resolve => {
        if (!res || typeof res.resume !== 'function') return resolve();
        res.resume();
        res.once('end', resolve);
        res.once('error', resolve);
    });
}

module.exports = { createRequester, createAgent, drainResponse, sanitizeHeaders };
