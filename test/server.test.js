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
