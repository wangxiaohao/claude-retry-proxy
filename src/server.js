'use strict';
// server.js — 本地反向代理服务：缓存请求体 → 带重试地转发到上游 → 透传响应。

const http = require('http');
const zlib = require('zlib');
const { requestWithRetry } = require('./retry');
const { createRequester, createAgent, drainResponse } = require('./upstream');

function ts() {
    return new Date().toISOString().slice(11, 23);
}

function makeLogger(config) {
    const out = msg => process.stderr.write(`[retry-proxy] ${ts()} ${msg}\n`);
    return {
        info: msg => out(`✓ ${msg}`),
        warn: msg => out(`⚠ ${msg}`),
        err:  msg => out(`✗ ${msg}`),
        debug: msg => { if (config.verbose) out(`· ${msg}`); },
    };
}

// 读取客户端请求体为单个 Buffer。
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.once('end', () => resolve(Buffer.concat(chunks)));
        req.once('error', reject);
    });
}

// 创建（但不启动）HTTP server。便于测试。
function createServer(config, deps = {}) {
    const log = deps.log || makeLogger(config);
    const agent = deps.agent || createAgent(config);
    // 允许测试注入 requester；默认基于真实 http/https。
    const requester = deps.requester || createRequester(config, agent);
    const sleep = deps.sleep; // 测试可注入；否则用 retry 默认

    const server = http.createServer(async (cReq, cRes) => {
        let body;
        try {
            body = await readBody(cReq);
        } catch (err) {
            log.warn(`读取客户端请求体失败: ${err.message}`);
            if (!cRes.headersSent) cRes.writeHead(400).end('读取请求体失败');
            return;
        }

        const doAttempt = () => requester(cReq.method, cReq.url, cReq.headers, body);

        let outcome;
        try {
            outcome = await requestWithRetry(doAttempt, {
                maxRetries:         config.maxRetries,
                retryStatuses:      config.retryStatuses,
                retryNetworkErrors: config.retryNetworkErrors,
                baseDelayMs:        config.baseDelayMs,
                maxDelayMs:         config.maxDelayMs,
                jitter:             config.jitter,
                statusDelays:       config.statusDelays,
                sleep,
                // 默认仅排空响应体；verbose 时把被重试的(可重试状态码)响应体打出来，
                // 用于诊断 403 到底是鉴权/权限/区域还是限流。discard 只会收到将被重试的响应，
                // 成功响应走的是透传路径，故这里不会记录到用户数据。
                discard: (res) => {
                    if (!config.verbose) return drainResponse(res);
                    return new Promise(resolve => {
                        const chunks = [];
                        res.on('data', c => chunks.push(c));
                        res.once('end', () => {
                            let buf = Buffer.concat(chunks);
                            try {
                                const enc = (res.headers['content-encoding'] || '').toLowerCase();
                                if (enc === 'gzip' || enc === 'x-gzip') buf = zlib.gunzipSync(buf);
                                else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
                                else if (enc === 'deflate') buf = zlib.inflateSync(buf);
                            } catch (_) { /* 解压失败就按原样打印 */ }
                            const body = buf.toString('utf8').slice(0, 500).replace(/\s+/g, ' ');
                            log.debug(`上游 ${res.statusCode} 响应体: ${body}`);
                            resolve();
                        });
                        res.once('error', () => resolve());
                    });
                },
                onRetry: ({ attempt, delay, maxRetries, statusCode, error }) => {
                    const cause = statusCode != null ? `状态 ${statusCode}` : `网络错误 ${error ? error.message : ''}`;
                    log.warn(`${cReq.method} ${cReq.url} 命中 ${cause}，第 ${attempt}/${maxRetries} 次重试（${delay}ms 后）`);
                },
            });
        } catch (err) {
            log.err(`上游请求最终失败: ${err.message}`);
            if (!cRes.headersSent) {
                cRes.writeHead(502, { 'content-type': 'application/json' });
                cRes.end(JSON.stringify({ error: 'bad_gateway', message: err.message }));
            } else {
                cRes.destroy();
            }
            return;
        }

        const { result: uRes, attempts } = outcome;
        if (attempts > 1) {
            // 最终状态码仍命中可重试集合 → 重试已耗尽、并非成功，只是把最后一次响应透传给客户端。
            if (config.retryStatuses.includes(uRes.statusCode)) {
                log.err(`${cReq.method} ${cReq.url} → ${uRes.statusCode}（重试 ${attempts - 1} 次后仍失败，已透传最终响应）`);
            } else {
                log.info(`${cReq.method} ${cReq.url} → ${uRes.statusCode}（第 ${attempts} 次尝试成功）`);
            }
        } else {
            log.debug(`${cReq.method} ${cReq.url} → ${uRes.statusCode}`);
        }

        // 透传响应（含 SSE 流式）。
        cRes.writeHead(uRes.statusCode, uRes.headers);
        uRes.pipe(cRes);
        uRes.once('error', () => { if (!cRes.destroyed) cRes.destroy(); });
        cReq.once('close', () => { if (uRes.destroy) uRes.destroy(); });
    });

    return server;
}

// 启动 server，打印引导信息。返回 server 实例。
function start(config, deps = {}) {
    const log = deps.log || makeLogger(config);
    const server = createServer(config, Object.assign({ log }, deps));

    server.on('error', err => {
        if (err.code === 'EADDRINUSE') {
            log.err(`端口 ${config.port} 已被占用，换个端口或停掉占用进程。`);
        } else {
            log.err(`服务启动失败: ${err.message}`);
        }
        process.exitCode = 1;
    });

    server.listen(config.port, config.host, () => {
        const url = `http://${config.host}:${config.port}`;
        log.info(`监听 ${url}`);
        log.info(`上游: ${config.targetProtocol}://${config.targetHost}:${config.targetPort}`);
        log.info(`出站代理: ${config.upstreamProxy || '直连（无）'}`);
        const fixed = Object.entries(config.statusDelays || {});
        const fixedDesc = fixed.length ? `，固定间隔 {${fixed.map(([c, ms]) => `${c}:${ms}ms`).join(', ')}}` : '';
        log.info(`重试: 状态码 [${config.retryStatuses.join(', ')}]，最多 ${config.maxRetries} 次，退避 ${config.baseDelayMs}~${config.maxDelayMs}ms${fixedDesc}`);
        log.info('────────────────────────────────────────────');
        log.info('让 Claude Code 走此代理：');
        log.info(`  临时:  ANTHROPIC_BASE_URL=${url} claude`);
        log.info(`  永久:  echo 'export ANTHROPIC_BASE_URL=${url}' >> ~/.zshrc`);
        log.info('────────────────────────────────────────────');
    });

    return server;
}

module.exports = { createServer, start, makeLogger, readBody };
