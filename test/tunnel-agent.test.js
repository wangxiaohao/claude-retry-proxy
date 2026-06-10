'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { TunnelAgent } = require('../src/tunnel-agent');

// 启动一个原始 TCP server 模拟出站代理，handler 拿到每个入站 socket。
function listenTcp(handler) {
    const server = net.createServer(handler);
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

function close(server) {
    return new Promise(r => server.close(r));
}

// 直接调用 createConnection，把 callback 包成 Promise。
function establish(agent, options) {
    return new Promise((resolve, reject) => {
        agent.createConnection(options, (err, socket) => {
            if (err) reject(err);
            else resolve(socket);
        });
    });
}

test('代理收下 CONNECT 但不回应：建连超时快速失败', async () => {
    const sockets = [];
    const { server, port } = await listenTcp(socket => {
        sockets.push(socket); // 故意不回应 CONNECT，模拟卡死的代理节点
    });

    const agent = new TunnelAgent(`http://127.0.0.1:${port}`, { establishTimeoutMs: 120 });
    const t0 = Date.now();
    await assert.rejects(
        establish(agent, { host: 'example.com', port: 443 }),
        /tunnel establish timeout \(120ms\)/
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1000, `应在超时附近失败（实际 ${elapsed}ms）`);

    sockets.forEach(s => s.destroy());
    await close(server);
});

test('CONNECT 成功但 TLS 握手卡死：同样被建连超时覆盖', async () => {
    const sockets = [];
    const { server, port } = await listenTcp(socket => {
        sockets.push(socket);
        // 回应隧道建立成功，但后续对 TLS ClientHello 保持沉默
        socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    });

    const agent = new TunnelAgent(`http://127.0.0.1:${port}`, { establishTimeoutMs: 120 });
    await assert.rejects(
        establish(agent, { host: 'example.com', port: 443 }),
        /tunnel establish timeout \(120ms\)/
    );

    sockets.forEach(s => s.destroy());
    await close(server);
});

test('代理拒绝 CONNECT（非 200）：立即报错，不等超时', async () => {
    const sockets = [];
    const { server, port } = await listenTcp(socket => {
        sockets.push(socket);
        socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });

    const agent = new TunnelAgent(`http://127.0.0.1:${port}`, { establishTimeoutMs: 5000 });
    const t0 = Date.now();
    await assert.rejects(
        establish(agent, { host: 'example.com', port: 443 }),
        /CONNECT 隧道建立失败: 502/
    );
    assert.ok(Date.now() - t0 < 1000, '应立即失败而非等满超时');

    sockets.forEach(s => s.destroy());
    await close(server);
});
