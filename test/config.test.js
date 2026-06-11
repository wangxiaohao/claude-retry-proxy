'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildConfig, parseStatusList, parseStatusDelays, parseBool, DEFAULTS } = require('../src/config');

test('默认值：无参数无环境变量', () => {
    const cfg = buildConfig([], {});
    assert.strictEqual(cfg.port, 7893);
    assert.strictEqual(cfg.targetHost, 'api.anthropic.com');
    assert.strictEqual(cfg.targetPort, 443);
    assert.strictEqual(cfg.maxRetries, 10);
    assert.strictEqual(cfg.upstreamProxy, '');
    assert.deepStrictEqual(cfg.retryStatuses, DEFAULTS.retryStatuses);
    assert.deepStrictEqual(cfg.statusDelays, { 403: 800 });
    assert.strictEqual(cfg.establishTimeoutMs, 10000);
    // 默认不限时：高延迟出站链路上正常请求的响应头可迟至 ~60s，激进默认值会误杀本会成功的请求
    assert.strictEqual(cfg.connectTimeoutMs, 0);
    assert.strictEqual(cfg.totalTimeoutMs, 0);
});

test('establish-timeout：flag 与环境变量解析，0=不限', () => {
    const a = buildConfig(['--establish-timeout', '5000'], {});
    assert.strictEqual(a.establishTimeoutMs, 5000);

    const b = buildConfig([], { RETRY_ESTABLISH_TIMEOUT_MS: '0' });
    assert.strictEqual(b.establishTimeoutMs, 0);

    // CLI 优先级高于环境变量
    const c = buildConfig(['--establish-timeout', '3000'], { RETRY_ESTABLISH_TIMEOUT_MS: '9999' });
    assert.strictEqual(c.establishTimeoutMs, 3000);
});

test('connect-timeout / total-timeout：flag 与环境变量解析', () => {
    const a = buildConfig(['--connect-timeout', '30000', '--total-timeout', '45000'], {});
    assert.strictEqual(a.connectTimeoutMs, 30000);
    assert.strictEqual(a.totalTimeoutMs, 45000);

    const b = buildConfig([], { RETRY_CONNECT_TIMEOUT_MS: '20000', RETRY_TOTAL_TIMEOUT_MS: '0' });
    assert.strictEqual(b.connectTimeoutMs, 20000);
    assert.strictEqual(b.totalTimeoutMs, 0);   // 0 = 不限，须被保留

    // CLI 优先级高于环境变量
    const c = buildConfig(['--total-timeout', '5000'], { RETRY_TOTAL_TIMEOUT_MS: '9999' });
    assert.strictEqual(c.totalTimeoutMs, 5000);
});

test('位置参数：[port] [proxy]（兼容旧脚本用法）', () => {
    const cfg = buildConfig(['7899', 'http://127.0.0.1:7890'], {});
    assert.strictEqual(cfg.port, 7899);
    assert.strictEqual(cfg.upstreamProxy, 'http://127.0.0.1:7890');
});

test('--key value 与 --key=value 两种形式', () => {
    const a = buildConfig(['--port', '8000', '--max-retries', '9'], {});
    assert.strictEqual(a.port, 8000);
    assert.strictEqual(a.maxRetries, 9);

    const b = buildConfig(['--port=8001', '--base-delay=250'], {});
    assert.strictEqual(b.port, 8001);
    assert.strictEqual(b.baseDelayMs, 250);
});

test('布尔标志：--verbose / -h', () => {
    const cfg = buildConfig(['--verbose'], {});
    assert.strictEqual(cfg.verbose, true);
    const h = buildConfig(['-h'], {});
    assert.strictEqual(h.help, true);
});

test('CLI 优先级高于环境变量', () => {
    const cfg = buildConfig(['--port', '9000'], { RETRY_PROXY_PORT: '1234' });
    assert.strictEqual(cfg.port, 9000);
});

test('环境变量在无 CLI 时生效', () => {
    const cfg = buildConfig([], { RETRY_PROXY_PORT: '1234', RETRY_MAX: '2' });
    assert.strictEqual(cfg.port, 1234);
    assert.strictEqual(cfg.maxRetries, 2);
});

test('HTTPS_PROXY / ALL_PROXY 作为出站代理回退', () => {
    const a = buildConfig([], { HTTPS_PROXY: 'http://127.0.0.1:7890' });
    assert.strictEqual(a.upstreamProxy, 'http://127.0.0.1:7890');
    const b = buildConfig([], { ALL_PROXY: 'socks5://127.0.0.1:7891' });
    assert.strictEqual(b.upstreamProxy, 'socks5://127.0.0.1:7891');
    // 显式 --proxy 覆盖环境变量
    const c = buildConfig(['--proxy', 'http://1.2.3.4:8080'], { HTTPS_PROXY: 'http://127.0.0.1:7890' });
    assert.strictEqual(c.upstreamProxy, 'http://1.2.3.4:8080');
});

test('retry-statuses 解析为数字数组，过滤非法值', () => {
    const cfg = buildConfig(['--retry-statuses', '403, 429 ,abc, 700, 503'], {});
    assert.deepStrictEqual(cfg.retryStatuses, [403, 429, 503]);
});

test('parseStatusList 非法输入回退默认', () => {
    assert.deepStrictEqual(parseStatusList('', [403]), [403]);
    assert.deepStrictEqual(parseStatusList('abc,xyz', [1]), [1]);
});

test('status-delays 从 flag 解析为 状态码→ms 映射', () => {
    const cfg = buildConfig(['--status-delays', '403:1500, 429:2000'], {});
    assert.deepStrictEqual(cfg.statusDelays, { 403: 1500, 429: 2000 });
});

test('status-delays 从 RETRY_STATUS_DELAYS 环境变量解析', () => {
    const cfg = buildConfig([], { RETRY_STATUS_DELAYS: '403:800' });
    assert.deepStrictEqual(cfg.statusDelays, { 403: 800 });
});

test('parseStatusDelays 过滤非法项，全非法/空则回退默认', () => {
    // 非法状态码、非法/负数延时被丢弃，合法项保留
    assert.deepStrictEqual(
        parseStatusDelays('403:1500, 700:1000, 429:abc, 503:-5, 500:0', { 403: 1500 }),
        { 403: 1500, 500: 0 }
    );
    assert.deepStrictEqual(parseStatusDelays('', { 403: 1500 }), { 403: 1500 });
    assert.deepStrictEqual(parseStatusDelays('garbage', { 403: 1500 }), { 403: 1500 });
});

test('parseBool 覆盖各种真假表示', () => {
    for (const v of ['1', 'true', 'YES', 'on']) assert.strictEqual(parseBool(v, false), true);
    for (const v of ['0', 'false', 'NO', 'off']) assert.strictEqual(parseBool(v, true), false);
    assert.strictEqual(parseBool('garbage', true), true); // 回退
});
