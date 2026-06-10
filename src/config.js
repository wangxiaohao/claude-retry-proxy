'use strict';
// config.js — 解析 CLI 参数与环境变量为运行时配置。
//
// 优先级: CLI 标志 > 环境变量 > 默认值。

const DEFAULTS = {
    port:          7893,
    host:          '127.0.0.1',
    targetHost:    'api.anthropic.com',
    targetPort:    443,
    targetProtocol:'https',
    upstreamProxy: '',      // 形如 http://127.0.0.1:7890，空表示直连
    maxRetries:    10,
    baseDelayMs:   600,
    maxDelayMs:    8000,
    establishTimeoutMs: 10000,  // 建连阶段（CONNECT 隧道+TLS 握手）上限，仅经出站代理时生效。0=不限
    connectTimeoutMs: 30000,    // 单次请求"发出→收到响应头"上限；超时即中断该次尝试（不影响 SSE 流）
    totalTimeoutMs:   60000,    // 从首次尝试起整轮重试的总时限；超时即停止重试。0=不限
    jitter:        true,
    retryStatuses: [403, 408, 429, 500, 502, 503, 504],
    statusDelays:  { 403: 800 },    // 状态码→固定重试间隔(ms)，命中即不走指数退避
    retryNetworkErrors: true,
    verbose:       false,
};

// 把 "403,429,503" 这样的字符串解析为数字数组。
function parseStatusList(value, fallback) {
    if (value == null || value === '') return fallback;
    const list = String(value)
        .split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => Number.isInteger(n) && n >= 100 && n <= 599);
    return list.length ? list : fallback;
}

// 把 "403:1500,429:2000" 解析为 { 403: 1500, 429: 2000 }。
// 丢弃非法状态码（须 100–599）与非法延时（须 >=0 的整数）；空/全非法时回退 fallback。
function parseStatusDelays(value, fallback) {
    if (value == null || value === '') return fallback;
    const map = {};
    for (const pair of String(value).split(',')) {
        const [k, v] = pair.split(':');
        const code = parseInt((k || '').trim(), 10);
        const ms = parseInt((v || '').trim(), 10);
        if (Number.isInteger(code) && code >= 100 && code <= 599 && Number.isInteger(ms) && ms >= 0) {
            map[code] = ms;
        }
    }
    return Object.keys(map).length ? map : fallback;
}

function parseBool(value, fallback) {
    if (value == null || value === '') return fallback;
    const v = String(value).toLowerCase().trim();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
    return fallback;
}

function parseIntOr(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

// argv: 原始进程参数（不含 node 与脚本路径）。
// env:  环境变量对象。
function buildConfig(argv = [], env = {}) {
    const flags = parseFlags(argv);

    const cfg = {
        port:          parseIntOr(flags.port ?? env.RETRY_PROXY_PORT, DEFAULTS.port),
        host:          flags.host ?? env.RETRY_PROXY_HOST ?? DEFAULTS.host,
        targetHost:    flags.target ?? env.RETRY_TARGET_HOST ?? DEFAULTS.targetHost,
        targetPort:    parseIntOr(flags['target-port'] ?? env.RETRY_TARGET_PORT, DEFAULTS.targetPort),
        targetProtocol:flags['target-protocol'] ?? env.RETRY_TARGET_PROTOCOL ?? DEFAULTS.targetProtocol,
        upstreamProxy: flags.proxy
                        ?? env.RETRY_UPSTREAM_PROXY
                        ?? env.HTTPS_PROXY ?? env.https_proxy
                        ?? env.ALL_PROXY  ?? env.all_proxy
                        ?? DEFAULTS.upstreamProxy,
        maxRetries:    parseIntOr(flags['max-retries'] ?? env.RETRY_MAX, DEFAULTS.maxRetries),
        baseDelayMs:   parseIntOr(flags['base-delay'] ?? env.RETRY_DELAY_MS, DEFAULTS.baseDelayMs),
        maxDelayMs:    parseIntOr(flags['max-delay'] ?? env.RETRY_MAX_DELAY_MS, DEFAULTS.maxDelayMs),
        establishTimeoutMs: parseIntOr(flags['establish-timeout'] ?? env.RETRY_ESTABLISH_TIMEOUT_MS, DEFAULTS.establishTimeoutMs),
        connectTimeoutMs: parseIntOr(flags['connect-timeout'] ?? env.RETRY_CONNECT_TIMEOUT_MS, DEFAULTS.connectTimeoutMs),
        totalTimeoutMs:   parseIntOr(flags['total-timeout'] ?? env.RETRY_TOTAL_TIMEOUT_MS, DEFAULTS.totalTimeoutMs),
        jitter:        parseBool(flags.jitter ?? env.RETRY_JITTER, DEFAULTS.jitter),
        retryStatuses: parseStatusList(flags['retry-statuses'] ?? env.RETRY_STATUSES, DEFAULTS.retryStatuses),
        statusDelays:  parseStatusDelays(flags['status-delays'] ?? env.RETRY_STATUS_DELAYS, DEFAULTS.statusDelays),
        retryNetworkErrors: parseBool(flags['retry-network-errors'] ?? env.RETRY_NETWORK_ERRORS, DEFAULTS.retryNetworkErrors),
        verbose:       parseBool(flags.verbose ?? env.RETRY_VERBOSE, DEFAULTS.verbose),
        help:          Boolean(flags.help || flags.h),
    };

    return cfg;
}

// 极简标志解析：支持 --key value、--key=value、--flag(布尔)、位置参数。
// 兼容旧用法: 第 1 个位置参数=port，第 2 个=upstreamProxy。
function parseFlags(argv) {
    const flags = {};
    const positional = [];

    for (let i = 0; i < argv.length; i++) {
        const tok = argv[i];
        if (tok.startsWith('--')) {
            const body = tok.slice(2);
            const eq = body.indexOf('=');
            if (eq >= 0) {
                flags[body.slice(0, eq)] = body.slice(eq + 1);
            } else {
                const next = argv[i + 1];
                if (next != null && !next.startsWith('--')) {
                    flags[body] = next;
                    i++;
                } else {
                    flags[body] = true; // 布尔标志
                }
            }
        } else if (tok.startsWith('-') && tok.length === 2) {
            flags[tok.slice(1)] = true;
        } else {
            positional.push(tok);
        }
    }

    // 兼容位置参数: [port] [proxy]
    if (positional[0] != null && flags.port == null) flags.port = positional[0];
    if (positional[1] != null && flags.proxy == null) flags.proxy = positional[1];

    return flags;
}

module.exports = { buildConfig, parseStatusList, parseStatusDelays, parseBool, parseIntOr, DEFAULTS };
