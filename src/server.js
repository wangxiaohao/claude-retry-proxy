'use strict';
// server.js — 本地反向代理服务：缓存请求体 → 带重试地转发到上游 → 透传响应。

const http = require('http');
const zlib = require('zlib');
const { requestWithRetry } = require('./retry');
const { createRequester, createAgent } = require('./upstream');

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

    // 每个客户端请求一个短 id，便于在并发交错的日志里关联同一请求的多次尝试。
    let reqSeq = 0;
    // 诊断头白名单：用于区分 Cloudflare 拦截 / API 鉴权 / 限流 / 上游来源。
    const DIAG_HEADERS = [
        'server', 'cf-ray', 'cf-mitigated', 'x-should-retry', 'retry-after',
        'anthropic-ratelimit-unified-status', 'request-id', 'x-request-id',
        'www-authenticate',
    ];

    const server = http.createServer(async (cReq, cRes) => {
        const reqId = `r${(++reqSeq).toString(36)}`;
        const startedAt = Date.now();
        const label = `[${reqId}] ${cReq.method} ${cReq.url}`;

        let body;
        try {
            body = await readBody(cReq);
        } catch (err) {
            log.warn(`${label} 读取客户端请求体失败: ${err.message}`);
            if (!cRes.headersSent) cRes.writeHead(400).end('读取请求体失败');
            return;
        }
        log.debug(`${label} 收到请求（body ${body.length}B）`);

        // 包装单次尝试，记录每次的状态码 / 网络错误与耗时（debug 级，verbose 可见）。
        let attemptNo = 0;
        const doAttempt = async () => {
            const n = ++attemptNo;
            const t0 = Date.now();
            try {
                const res = await requester(cReq.method, cReq.url, cReq.headers, body);
                log.debug(`${label} 尝试#${n} → ${res.statusCode}（${Date.now() - t0}ms）`);
                return res;
            } catch (err) {
                log.debug(`${label} 尝试#${n} 网络错误：${err.message}（${Date.now() - t0}ms）`);
                throw err;
            }
        };

        // 重试前丢弃上一次（将被重试的）错误响应体，并顺带记录诊断头与响应体摘要。
        // discard 只接收会被重试的错误响应（403/5xx 等），不含成功用户数据，记录是安全的，
        // 也是判断 403 究竟来自 Cloudflare 拦截、API 鉴权还是限流的关键依据。
        // 默认即记录头与 200 字符摘要；verbose 时摘要放宽到 800 字符。
        const discardAndDiagnose = (res) => {
            const h = res.headers || {};
            const diag = DIAG_HEADERS.filter(k => h[k] != null).map(k => `${k}=${h[k]}`).join(' ');
            if (diag) log.warn(`${label} 上游 ${res.statusCode} 头：${diag}`);
            return new Promise(resolve => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.once('end', () => {
                    let buf = Buffer.concat(chunks);
                    try {
                        const enc = (h['content-encoding'] || '').toLowerCase();
                        if (enc === 'gzip' || enc === 'x-gzip') buf = zlib.gunzipSync(buf);
                        else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
                        else if (enc === 'deflate') buf = zlib.inflateSync(buf);
                    } catch (_) { /* 解压失败就按原样打印 */ }
                    const limit = config.verbose ? 800 : 200;
                    const snippet = buf.toString('utf8').slice(0, limit).replace(/\s+/g, ' ').trim();
                    if (snippet) log.warn(`${label} 上游 ${res.statusCode} 响应体：${snippet}`);
                    resolve();
                });
                res.once('error', () => resolve());
            });
        };

        let outcome;
        try {
            outcome = await requestWithRetry(doAttempt, {
                maxRetries:         config.maxRetries,
                totalTimeoutMs:     config.totalTimeoutMs,
                retryStatuses:      config.retryStatuses,
                retryNetworkErrors: config.retryNetworkErrors,
                baseDelayMs:        config.baseDelayMs,
                maxDelayMs:         config.maxDelayMs,
                jitter:             config.jitter,
                statusDelays:       config.statusDelays,
                sleep,
                discard: discardAndDiagnose,
                onRetry: ({ attempt, delay, maxRetries, statusCode, error }) => {
                    const cause = statusCode != null ? `状态 ${statusCode}` : `网络错误 ${error ? error.message : ''}`;
                    log.warn(`${label} 命中 ${cause}，第 ${attempt}/${maxRetries} 次重试（${delay}ms 后）`);
                },
            });
        } catch (err) {
            log.err(`${label} 上游请求最终失败：${err.message}（${attemptNo} 次尝试，耗时 ${Date.now() - startedAt}ms）`);
            if (!cRes.headersSent) {
                cRes.writeHead(502, { 'content-type': 'application/json' });
                cRes.end(JSON.stringify({ error: 'bad_gateway', message: err.message }));
            } else {
                cRes.destroy();
            }
            return;
        }

        const elapsed = Date.now() - startedAt;
        const { result: uRes, attempts } = outcome;
        if (attempts > 1) {
            // 最终状态码仍命中可重试集合 → 重试已耗尽、并非成功，只是把最后一次响应透传给客户端。
            if (config.retryStatuses.includes(uRes.statusCode)) {
                log.err(`${label} → ${uRes.statusCode}（重试 ${attempts - 1} 次后仍失败，耗时 ${elapsed}ms，已透传最终响应）`);
            } else {
                log.info(`${label} → ${uRes.statusCode}（第 ${attempts} 次尝试成功，耗时 ${elapsed}ms）`);
            }
        } else {
            log.debug(`${label} → ${uRes.statusCode}（${elapsed}ms）`);
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
        const totalDesc = config.totalTimeoutMs > 0 ? `${config.totalTimeoutMs}ms` : '不限';
        const establishDesc = config.establishTimeoutMs > 0 ? `${config.establishTimeoutMs}ms` : '不限';
        const connectDesc = config.connectTimeoutMs > 0 ? `${config.connectTimeoutMs}ms` : '不限';
        log.info(`超时: 建连 ${establishDesc}，单次连接 ${connectDesc}，整轮重试 ${totalDesc}`);
        log.info('────────────────────────────────────────────');
        log.info('让 Claude Code 走此代理：');
        log.info(`  临时:  ANTHROPIC_BASE_URL=${url} claude`);
        log.info(`  永久:  echo 'export ANTHROPIC_BASE_URL=${url}' >> ~/.zshrc`);
        log.info('────────────────────────────────────────────');
    });

    return server;
}

module.exports = { createServer, start, makeLogger, readBody };
