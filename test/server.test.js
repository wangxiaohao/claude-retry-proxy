'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createServer } = require('../src/server');
const { buildConfig } = require('../src/config');

const silentLog = { info() {}, warn() {}, err() {}, debug() {} };
const noSleep = () => Promise.resolve();

// 启动一个监听随机端口的 http server，resolve 端口。
function listen(server) {
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function closeAll(...servers) {
    return Promise.all(servers.map(s => new Promise(r => s.close(r))));
}

// 发起一次对本地代理的请求，收集完整响应。
function request(port, { method = 'POST', path = '/v1/messages', headers = {}, body = '' } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { hostname: '127.0.0.1', port, path, method, headers },
            res => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.once('end', () => resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString('utf8'),
                }));
            }
        );
        req.once('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// 构造指向本地伪上游的配置。
function configFor(upstreamPort, overrides = {}) {
    return buildConfig([], Object.assign({
        RETRY_TARGET_HOST: '127.0.0.1',
        RETRY_TARGET_PORT: String(upstreamPort),
        RETRY_TARGET_PROTOCOL: 'http',
        RETRY_DELAY_MS: '1',
    }, overrides));
}

test('403 两次后成功：代理对客户端只返回最终 200', async () => {
    let hits = 0;
    const upstream = http.createServer((req, res) => {
        hits++;
        if (hits <= 2) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end('{"error":"forbidden"}');
        } else {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"ok":true,"hit":' + hits + '}');
        }
    });
    const upstreamPort = await listen(upstream);

    const cfg = configFor(upstreamPort);
    const proxy = createServer(cfg, { log: silentLog, sleep: noSleep });
    const proxyPort = await listen(proxy);

    const resp = await request(proxyPort, { body: '{"model":"claude"}' });
    assert.strictEqual(resp.statusCode, 200);
    assert.strictEqual(resp.body, '{"ok":true,"hit":3}');
    assert.strictEqual(hits, 3); // 上游被打了 3 次

    await closeAll(upstream, proxy);
});

test('请求体在每次重试都被完整重发', async () => {
    const received = [];
    let hits = 0;
    const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.once('end', () => {
            received.push(Buffer.concat(chunks).toString('utf8'));
            hits++;
            if (hits === 1) { res.writeHead(403).end('no'); }
            else { res.writeHead(200).end('yes'); }
        });
    });
    const upstreamPort = await listen(upstream);

    const cfg = configFor(upstreamPort);
    const proxy = createServer(cfg, { log: silentLog, sleep: noSleep });
    const proxyPort = await listen(proxy);

    const payload = '{"model":"claude","msg":"重试也要带上 body"}';
    const resp = await request(proxyPort, { body: payload });
    assert.strictEqual(resp.statusCode, 200);
    assert.deepStrictEqual(received, [payload, payload]); // 两次都收到相同 body

    await closeAll(upstream, proxy);
});

test('非重试状态（401）直接透传，不重试', async () => {
    let hits = 0;
    const upstream = http.createServer((req, res) => {
        hits++;
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"unauthorized"}');
    });
    const upstreamPort = await listen(upstream);

    const cfg = configFor(upstreamPort);
    const proxy = createServer(cfg, { log: silentLog, sleep: noSleep });
    const proxyPort = await listen(proxy);

    const resp = await request(proxyPort, { body: '{}' });
    assert.strictEqual(resp.statusCode, 401);
    assert.strictEqual(resp.body, '{"error":"unauthorized"}');
    assert.strictEqual(hits, 1);

    await closeAll(upstream, proxy);
});

test('SSE 流式响应被原样透传', async () => {
    const upstream = http.createServer((req, res) => {
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
        });
        res.write('event: message_start\ndata: {"a":1}\n\n');
        res.write('event: content_block_delta\ndata: {"b":2}\n\n');
        res.end('event: message_stop\ndata: {}\n\n');
    });
    const upstreamPort = await listen(upstream);

    const cfg = configFor(upstreamPort);
    const proxy = createServer(cfg, { log: silentLog, sleep: noSleep });
    const proxyPort = await listen(proxy);

    const resp = await request(proxyPort, { body: '{"stream":true}' });
    assert.strictEqual(resp.statusCode, 200);
    assert.strictEqual(resp.headers['content-type'], 'text/event-stream');
    assert.match(resp.body, /message_start/);
    assert.match(resp.body, /content_block_delta/);
    assert.match(resp.body, /message_stop/);

    await closeAll(upstream, proxy);
});

test('上游始终 403：耗尽重试后把最后的 403 透传给客户端', async () => {
    let hits = 0;
    const upstream = http.createServer((req, res) => {
        hits++;
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end('{"error":"forbidden"}');
    });
    const upstreamPort = await listen(upstream);

    const cfg = configFor(upstreamPort, { RETRY_MAX: '2' });
    const proxy = createServer(cfg, { log: silentLog, sleep: noSleep });
    const proxyPort = await listen(proxy);

    const resp = await request(proxyPort, { body: '{}' });
    assert.strictEqual(resp.statusCode, 403);
    assert.strictEqual(hits, 3); // 1 首发 + 2 重试

    await closeAll(upstream, proxy);
});

test('上游连接失败：重试耗尽后返回 502', async () => {
    // 指向一个没有监听的端口，触发 ECONNREFUSED。
    const deadPort = 1; // 普通用户无法监听，连接必失败
    const cfg = configFor(deadPort, { RETRY_MAX: '1' });
    const proxy = createServer(cfg, { log: silentLog, sleep: noSleep });
    const proxyPort = await listen(proxy);

    const resp = await request(proxyPort, { body: '{}' });
    assert.strictEqual(resp.statusCode, 502);
    assert.match(resp.body, /bad_gateway/);

    await closeAll(proxy);
});

test('上游迟迟不返回响应头：连接超时中断该次尝试 → 重试耗尽后 502', async () => {
    let hits = 0;
    const held = [];
    const upstream = http.createServer((req, res) => {
        hits++;
        held.push(res); // 故意不写响应头，挂起，模拟卡死的隧道连接
    });
    const upstreamPort = await listen(upstream);

    // 连接超时 120ms；noSleep 让重试立即发生。
    const cfg = configFor(upstreamPort, { RETRY_MAX: '1', RETRY_CONNECT_TIMEOUT_MS: '120' });
    const proxy = createServer(cfg, { log: silentLog, sleep: noSleep });
    const proxyPort = await listen(proxy);

    const resp = await request(proxyPort, { body: '{}' });
    assert.strictEqual(resp.statusCode, 502);
    assert.match(resp.body, /timeout/i);
    assert.strictEqual(hits, 2); // 1 首发 + 1 重试，均因连接超时被中断

    held.forEach(res => res.destroy());
    await closeAll(upstream, proxy);
});

test('连接超时不影响已开始的 SSE 流（响应头到达后即解除计时）', async () => {
    const upstream = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: a\ndata: 1\n\n');
        // 在超过 connectTimeoutMs 之后才发后续块：若计时未解除，流会被中断、丢块。
        setTimeout(() => {
            res.write('event: b\ndata: 2\n\n');
            res.end('event: done\ndata: {}\n\n');
        }, 150);
    });
    const upstreamPort = await listen(upstream);

    const cfg = configFor(upstreamPort, { RETRY_CONNECT_TIMEOUT_MS: '80' });
    const proxy = createServer(cfg, { log: silentLog, sleep: noSleep });
    const proxyPort = await listen(proxy);

    const resp = await request(proxyPort, { body: '{"stream":true}' });
    assert.strictEqual(resp.statusCode, 200);
    assert.match(resp.body, /event: a/);
    assert.match(resp.body, /event: b/);   // 慢块仍完整透传
    assert.match(resp.body, /event: done/);

    await closeAll(upstream, proxy);
});

test('GET 无 body 请求也能正常代理', async () => {
    const upstream = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"models":[]}');
    });
    const upstreamPort = await listen(upstream);

    const cfg = configFor(upstreamPort);
    const proxy = createServer(cfg, { log: silentLog, sleep: noSleep });
    const proxyPort = await listen(proxy);

    const resp = await request(proxyPort, { method: 'GET', path: '/v1/models' });
    assert.strictEqual(resp.statusCode, 200);
    assert.strictEqual(resp.body, '{"models":[]}');

    await closeAll(upstream, proxy);
});

test('总时长上限：到点停止重试，把最后一次 403 透传（不等满 maxRetries）', async () => {
    let hits = 0;
    const upstream = http.createServer((req, res) => {
        hits++;
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end('{"error":"forbidden"}');
    });
    const upstreamPort = await listen(upstream);

    // 403 固定间隔 60ms，总时限 150ms：约 2~3 次尝试后必须停（远小于 maxRetries=50）。
    const cfg = configFor(upstreamPort, {
        RETRY_MAX: '50',
        RETRY_STATUS_DELAYS: '403:60',
        RETRY_TOTAL_TIMEOUT_MS: '150',
    });
    const proxy = createServer(cfg, { log: silentLog }); // 用真实 sleep，验证真实时间闸门
    const proxyPort = await listen(proxy);

    const t0 = Date.now();
    const resp = await request(proxyPort, { body: '{}' });
    assert.strictEqual(resp.statusCode, 403);
    assert.ok(hits < 10, `应远少于 51 次（实际 ${hits} 次）`);
    assert.ok(Date.now() - t0 < 1500, '总耗时应被压在上限附近');

    await closeAll(upstream, proxy);
});
