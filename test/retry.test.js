'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { requestWithRetry, computeDelay } = require('../src/retry');

const noSleep = () => Promise.resolve();

test('首次即成功，attempts=1，不触发重试', async () => {
    let calls = 0;
    const { result, attempts } = await requestWithRetry(
        () => { calls++; return Promise.resolve({ statusCode: 200 }); },
        { maxRetries: 5, retryStatuses: [403], sleep: noSleep }
    );
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(attempts, 1);
    assert.strictEqual(calls, 1);
});

test('403 两次后成功，attempts=3', async () => {
    const seq = [403, 403, 200];
    let i = 0;
    const retries = [];
    const { result, attempts } = await requestWithRetry(
        () => Promise.resolve({ statusCode: seq[i++] }),
        {
            maxRetries: 5,
            retryStatuses: [403],
            sleep: noSleep,
            onRetry: info => retries.push(info.attempt),
        }
    );
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(attempts, 3);
    assert.deepStrictEqual(retries, [1, 2]);
});

test('始终 403，耗尽重试后返回最后一次 403（不抛错）', async () => {
    let calls = 0;
    const { result, attempts } = await requestWithRetry(
        () => { calls++; return Promise.resolve({ statusCode: 403 }); },
        { maxRetries: 3, retryStatuses: [403], sleep: noSleep }
    );
    assert.strictEqual(result.statusCode, 403);
    assert.strictEqual(attempts, 4);       // 1 次首发 + 3 次重试
    assert.strictEqual(calls, 4);
});

test('非重试状态码（如 401）立即返回，不重试', async () => {
    let calls = 0;
    const { result, attempts } = await requestWithRetry(
        () => { calls++; return Promise.resolve({ statusCode: 401 }); },
        { maxRetries: 5, retryStatuses: [403], sleep: noSleep }
    );
    assert.strictEqual(result.statusCode, 401);
    assert.strictEqual(attempts, 1);
    assert.strictEqual(calls, 1);
});

test('网络错误在 retryNetworkErrors=true 时重试', async () => {
    let calls = 0;
    const { result, attempts } = await requestWithRetry(
        () => {
            calls++;
            if (calls < 3) return Promise.reject(new Error('ECONNRESET'));
            return Promise.resolve({ statusCode: 200 });
        },
        { maxRetries: 5, retryStatuses: [403], retryNetworkErrors: true, sleep: noSleep }
    );
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(attempts, 3);
    assert.strictEqual(calls, 3);
});

test('网络错误在 retryNetworkErrors=false 时直接抛出', async () => {
    await assert.rejects(
        () => requestWithRetry(
            () => Promise.reject(new Error('boom')),
            { maxRetries: 5, retryStatuses: [403], retryNetworkErrors: false, sleep: noSleep }
        ),
        /boom/
    );
});

test('持续网络错误耗尽重试后抛出最后一次错误', async () => {
    let calls = 0;
    await assert.rejects(
        () => requestWithRetry(
            () => { calls++; return Promise.reject(new Error(`fail-${calls}`)); },
            { maxRetries: 2, retryStatuses: [403], retryNetworkErrors: true, sleep: noSleep }
        ),
        /fail-3/
    );
    assert.strictEqual(calls, 3);
});

test('重试前调用 discard 丢弃上一次响应体', async () => {
    const seq = [403, 200];
    let i = 0;
    const discarded = [];
    await requestWithRetry(
        () => Promise.resolve({ statusCode: seq[i], _id: i++ }),
        {
            maxRetries: 5,
            retryStatuses: [403],
            sleep: noSleep,
            discard: res => { discarded.push(res._id); return Promise.resolve(); },
        }
    );
    assert.deepStrictEqual(discarded, [0]); // 只丢弃了那次 403
});

test('discard 抛错不应中断重试', async () => {
    const seq = [403, 200];
    let i = 0;
    const { result } = await requestWithRetry(
        () => Promise.resolve({ statusCode: seq[i++] }),
        {
            maxRetries: 5,
            retryStatuses: [403],
            sleep: noSleep,
            discard: () => Promise.reject(new Error('drain failed')),
        }
    );
    assert.strictEqual(result.statusCode, 200);
});

test('onRetry 收到正确的 attempt/statusCode/delay', async () => {
    const seq = [403, 503, 200];
    let i = 0;
    const infos = [];
    await requestWithRetry(
        () => Promise.resolve({ statusCode: seq[i++] }),
        {
            maxRetries: 5,
            retryStatuses: [403, 503],
            jitter: false,
            baseDelayMs: 100,
            maxDelayMs: 10000,
            sleep: noSleep,
            onRetry: info => infos.push(info),
        }
    );
    assert.strictEqual(infos.length, 2);
    assert.strictEqual(infos[0].statusCode, 403);
    assert.strictEqual(infos[0].delay, 100);   // 100 * 2^0
    assert.strictEqual(infos[1].statusCode, 503);
    assert.strictEqual(infos[1].delay, 200);   // 100 * 2^1
});

test('computeDelay 指数退避，无抖动', () => {
    const opt = { baseDelayMs: 500, maxDelayMs: 8000, jitter: false };
    assert.strictEqual(computeDelay(1, opt), 500);
    assert.strictEqual(computeDelay(2, opt), 1000);
    assert.strictEqual(computeDelay(3, opt), 2000);
    assert.strictEqual(computeDelay(4, opt), 4000);
});

test('computeDelay 受 maxDelayMs 封顶', () => {
    const opt = { baseDelayMs: 500, maxDelayMs: 3000, jitter: false };
    assert.strictEqual(computeDelay(5, opt), 3000); // 500*16=8000 → 封顶 3000
});

test('computeDelay 抖动落在 [cap/2, cap]', () => {
    const opt = { baseDelayMs: 1000, maxDelayMs: 8000, jitter: true, random: () => 0 };
    assert.strictEqual(computeDelay(1, opt), 500);  // cap=1000, random=0 → 500
    const opt2 = { baseDelayMs: 1000, maxDelayMs: 8000, jitter: true, random: () => 1 };
    assert.strictEqual(computeDelay(1, opt2), 1000); // random=1 → 1000
});

test('computeDelay: statusDelays 命中状态码时返回固定值（不指数、不抖动、不封顶）', () => {
    const opt = { baseDelayMs: 600, maxDelayMs: 800, jitter: true, statusDelays: { 403: 1500 }, statusCode: 403, random: () => 0 };
    assert.strictEqual(computeDelay(1, opt), 1500);
    assert.strictEqual(computeDelay(5, opt), 1500); // 任意 attempt 都固定，且超过 maxDelayMs 也不封顶
});

test('computeDelay: 未命中 statusDelays 的状态码仍走指数退避', () => {
    const opt = { baseDelayMs: 500, maxDelayMs: 8000, jitter: false, statusDelays: { 403: 1500 }, statusCode: 503 };
    assert.strictEqual(computeDelay(1, opt), 500);
    assert.strictEqual(computeDelay(2, opt), 1000);
});

test('computeDelay: statusCode 为空（网络错误）走指数退避', () => {
    const opt = { baseDelayMs: 500, maxDelayMs: 8000, jitter: false, statusDelays: { 403: 1500 } };
    assert.strictEqual(computeDelay(1, opt), 500);
});

test('requestWithRetry: 403 使用固定间隔，每次重试 delay 均为 statusDelays[403]', async () => {
    const seq = [403, 403, 403, 200];
    let i = 0;
    const delays = [];
    const { result, attempts } = await requestWithRetry(
        () => Promise.resolve({ statusCode: seq[i++] }),
        {
            maxRetries: 10,
            retryStatuses: [403],
            statusDelays: { 403: 1500 },
            jitter: true,              // 即便开了抖动，固定间隔也不抖
            baseDelayMs: 600,
            sleep: noSleep,
            onRetry: info => delays.push(info.delay),
        }
    );
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(attempts, 4);
    assert.deepStrictEqual(delays, [1500, 1500, 1500]);
});

test('requestWithRetry: 仅 403 固定，503 仍指数退避', async () => {
    const seq = [403, 503, 200];
    let i = 0;
    const infos = [];
    await requestWithRetry(
        () => Promise.resolve({ statusCode: seq[i++] }),
        {
            maxRetries: 10,
            retryStatuses: [403, 503],
            statusDelays: { 403: 1500 },
            jitter: false,
            baseDelayMs: 100,
            maxDelayMs: 10000,
            sleep: noSleep,
            onRetry: info => infos.push(info),
        }
    );
    assert.strictEqual(infos[0].statusCode, 403);
    assert.strictEqual(infos[0].delay, 1500);   // 固定
    assert.strictEqual(infos[1].statusCode, 503);
    assert.strictEqual(infos[1].delay, 200);    // 100 * 2^1，指数
});

test('requestWithRetry: 网络错误不命中固定表，走指数退避', async () => {
    let calls = 0;
    const delays = [];
    await requestWithRetry(
        () => {
            calls++;
            if (calls < 3) return Promise.reject(new Error('socket hang up'));
            return Promise.resolve({ statusCode: 200 });
        },
        {
            maxRetries: 10,
            retryStatuses: [403],
            statusDelays: { 403: 1500 },
            retryNetworkErrors: true,
            jitter: false,
            baseDelayMs: 100,
            maxDelayMs: 10000,
            sleep: noSleep,
            onRetry: info => delays.push(info.delay),
        }
    );
    assert.deepStrictEqual(delays, [100, 200]); // 指数，而非 1500
});

// 用一个可手动推进的假时钟：每次读 now() 返回当前 t；sleep 把 t 前移。
function fakeClock(start = 0) {
    let t = start;
    return {
        now: () => t,
        sleep: ms => { t += ms; return Promise.resolve(); },
        advance: ms => { t += ms; },
        get t() { return t; },
    };
}

test('totalTimeoutMs=0（默认）时不限时，重试至成功', async () => {
    const seq = [429, 429, 429, 200];
    let i = 0;
    const { result, attempts } = await requestWithRetry(
        () => Promise.resolve({ statusCode: seq[i++] }),
        { maxRetries: 10, retryStatuses: [429], totalTimeoutMs: 0, jitter: false, baseDelayMs: 100, sleep: noSleep }
    );
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(attempts, 4);
});

test('totalTimeoutMs: 超过总时限后停止重试，透传最后一次响应', async () => {
    const clock = fakeClock();
    let calls = 0;
    // 持续 429，固定间隔 400，totalTimeoutMs=1000。每次尝试后判定截止：
    // 尝试1(t=0)429→sleep400 t=400 → 尝试2 429→sleep400 t=800 → 尝试3 429→sleep截到200 t=1000
    //  → 尝试4 429 此时 t=1000 已到截止 → 停，透传这次 429（而非抛错→502）。
    const { result, attempts } = await requestWithRetry(
        () => { calls++; return Promise.resolve({ statusCode: 429 }); },
        {
            maxRetries: 10,
            retryStatuses: [429],
            totalTimeoutMs: 1000,
            statusDelays: { 429: 400 },
            now: clock.now,
            sleep: clock.sleep,
        }
    );
    assert.strictEqual(result.statusCode, 429);   // 透传最后一次，而非抛错
    assert.strictEqual(calls, 4);                 // 远没跑满 11 次
    assert.strictEqual(attempts, 4);
});

test('totalTimeoutMs: 网络错误下超时则抛出最后一次错误', async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
        () => requestWithRetry(
            () => { calls++; return Promise.reject(new Error(`neterr-${calls}`)); },
            {
                maxRetries: 10,
                retryStatuses: [429],
                retryNetworkErrors: true,
                totalTimeoutMs: 1000,
                jitter: false,
                baseDelayMs: 600,
                now: clock.now,
                sleep: clock.sleep,
            }
        ),
        /neterr-3/
    );
    // 尝试1(t=0)err→sleep600 t=600 → 尝试2 err→sleep截到400 t=1000 → 尝试3 err 此时 t=1000 已到截止
    //  → 抛出最后一次错误 neterr-3。
    assert.strictEqual(calls, 3);
});

test('totalTimeoutMs: sleep 时长被剩余时间截断，不会多等', async () => {
    const clock = fakeClock();
    const slept = [];
    const origSleep = clock.sleep;
    const seq = [429, 429, 429, 429, 429];
    let i = 0;
    await requestWithRetry(
        () => Promise.resolve({ statusCode: seq[i++] ?? 429 }),
        {
            maxRetries: 10,
            retryStatuses: [429],
            totalTimeoutMs: 1000,
            statusDelays: { 429: 700 },   // 单次间隔 700
            now: clock.now,
            sleep: ms => { slept.push(ms); return origSleep(ms); },
        }
    );
    // t=0 尝试1 → sleep min(700, 1000)=700, t=700 → 尝试2 → 进第3次前 t=700，
    // sleep min(700, 1000-700=300)=300, t=1000 → 第3次前 t>=1000 停。
    assert.deepStrictEqual(slept, [700, 300]);
});
